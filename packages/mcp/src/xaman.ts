// Phone approvals through Xaman. When the agent asks for something the linked wallet must sign, the adapter prepares
// the exact transaction and pushes a sign request to the owner's phone. Xaman only SIGNS (submit: false); the adapter
// checks what came back (network, account, unchanged transaction) and submits it itself — then closes the approval the
// same way the console does (validated on the ledger + matches the intent). The console keeps working in parallel:
// whichever surface finishes first wins, and the other one is cancelled.
//
// Needs the Xaman app's API key AND secret (XRPL_XAMAN_API_KEY / XRPL_XAMAN_API_SECRET) — the secret stays in this
// process's environment, is never logged, and is never sent to the console or the agent.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Ledger, prepareFromIntent, prepareX402Payment, signedBlobProblem, submitSigned, listTickets, transferMethod, type Prepared,
} from "@xrpl-agent/core";
import { approvals, type Approval } from "./approvals.js";
import { finalizeApproval } from "./finalize.js";
import { quoteX402, redeemX402 } from "./x402-approvals.js";

/** The parts of the Xaman API we use. The real one wraps xumm-sdk; tests plug in a fake phone. */
export interface XamanClient {
  createAndSubscribe(body: Record<string, unknown>, onEvent: (e: { data: any }) => unknown):
    Promise<{ created: { uuid: string; next?: { always?: string }; refs?: { qr_png?: string } }; resolved: Promise<unknown> }>;
  get(uuid: string): Promise<any>;
  cancel(uuid: string): Promise<unknown>;
}

export async function xummClient(apiKey: string, apiSecret: string): Promise<XamanClient> {
  const { XummSdk } = await import("xumm-sdk");
  const sdk = new XummSdk(apiKey, apiSecret);
  return {
    createAndSubscribe: (body, cb) => sdk.payload.createAndSubscribe(body as any, cb as any) as any,
    get: (uuid) => sdk.payload.get(uuid) as any,
    cancel: (uuid) => sdk.payload.cancel(uuid) as any,
  };
}

const HOME = process.env.XRPL_AGENT_HOME || join(homedir(), ".xrpl-agent");
const LINK_FILE = join(HOME, "xaman.json");
interface Link { account: string; userToken: string; linkedAt: string }
const NETWORK: Record<string, { force: string; id: number }> = { mainnet: { force: "MAINNET", id: 0 }, testnet: { force: "TESTNET", id: 1 }, devnet: { force: "DEVNET", id: 2 } };
const signedFlag = (e: { data: any }) => (typeof e?.data?.signed === "boolean" ? e.data : undefined);

export class XamanBridge {
  private readonly live = new Map<string, string>();   // approval id → payload uuid (still open on the phone)
  constructor(private readonly ledger: Ledger, private readonly client: XamanClient,
              private readonly opts: { expireMinutes?: number; log?: (...a: unknown[]) => void } = {}) {
    approvals.onAdd((a) => { if (this.wants(a)) this.push(a).catch((e) => this.note(a.id, "error", String(e?.message ?? e))); });
    approvals.onChange((a) => {                         // finished elsewhere (console) → withdraw the phone request
      const uuid = this.live.get(a.id);
      if (uuid && a.status !== "pending" && a.status !== "submitted") {
        this.live.delete(a.id);
        if (a.phone?.state === "sent") { this.client.cancel(uuid).catch(() => {}); this.note(a.id, "cancelled", `finished in the console (${a.status})`); }
      }
    });
  }

  private get expire() { return Math.max(1, Math.min(60, this.opts.expireMinutes ?? 10)); }
  private log(...a: unknown[]) { this.opts.log?.(...a); }

  link(): Link | null {
    try { return existsSync(LINK_FILE) ? JSON.parse(readFileSync(LINK_FILE, "utf8")) : null; } catch { return null; }
  }
  status() {
    const l = this.link();
    return { configured: true, linked: !!l, account: l?.account, linkedAt: l?.linkedAt, network: this.ledger.network };
  }
  unlink() { try { unlinkSync(LINK_FILE); } catch { /* not linked */ } return this.status(); }

  /** Start linking: the owner signs in with Xaman once; afterwards sign requests are pushed to that phone. */
  async startLink(): Promise<{ url?: string; qr?: string; uuid: string }> {
    const sub = await this.client.createAndSubscribe({ txjson: { TransactionType: "SignIn" }, options: { expire: this.expire },
      custom_meta: { instruction: "Link this phone to approve your AI agent's XRPL requests" } }, signedFlag);
    sub.resolved.then(async (r: any) => {
      if (!r?.signed) return this.log("xaman link: not signed");
      const p = await this.client.get(sub.created.uuid);
      const userToken = p?.application?.issued_user_token, account = p?.response?.account;
      if (!userToken || !account) return this.log("xaman link: no user token in the result");
      mkdirSync(HOME, { recursive: true, mode: 0o700 });
      writeFileSync(LINK_FILE + ".tmp", JSON.stringify({ account, userToken, linkedAt: new Date().toISOString() } satisfies Link, null, 2), { mode: 0o600 });
      renameSync(LINK_FILE + ".tmp", LINK_FILE);
      this.log("xaman: phone linked for", account);
    }).catch((e) => this.log("xaman link failed:", e?.message ?? e));
    return { uuid: sub.created.uuid, url: sub.created.next?.always, qr: sub.created.refs?.qr_png };
  }

  /** Will this approval go to the phone? (linked, same account, same network) */
  wants(a: Approval): boolean {
    const l = this.link();
    const acct = (a.intent.input as { account?: string }).account;
    return !!l && a.status === "pending" && a.network === this.ledger.network && acct === l.account;
  }

  private note(id: string, state: NonNullable<Approval["phone"]>["state"], note?: string) {
    const a = approvals.get(id);
    if (a) approvals.update(id, { phone: { ...(a.phone ?? { uuid: "", sentAt: new Date().toISOString() }), state, note } });
  }

  /** Prepare the exact transaction and push it to the phone; resolution is handled in the background. */
  async push(a: Approval): Promise<void> {
    const l = this.link()!;
    const net = NETWORK[this.ledger.network];
    let prepared: Prepared<any>, expire = this.expire;
    if (a.intent.tool === "x402") {
      const req = await quoteX402(this.ledger, a);                 // fresh quote; price can't go up
      const ticket = transferMethod(req) === "ticketSequence" ? (await listTickets(this.ledger, l.account))[0] : undefined;
      if (transferMethod(req) === "ticketSequence" && ticket === undefined) throw new Error("this seller needs an XRPL Ticket on your account");
      prepared = await prepareX402Payment(this.ledger, l.account, req, { ticket });
      expire = Math.max(1, Math.min(expire, Math.floor(req.maxTimeoutSeconds / 60)));   // the seller's invoice expires
    } else {
      prepared = await prepareFromIntent(this.ledger, a.intent);
      // a person on a phone needs longer than the ~1 minute autofill allows: keep it valid while the request is open
      const validated = Number((await this.ledger.request<any>({ command: "ledger", ledger_index: "validated" })).ledger_index);
      prepared.tx.LastLedgerSequence = validated + Math.ceil((expire * 60) / 3) + 10;
    }
    const sub = await this.client.createAndSubscribe({
      txjson: prepared.tx, user_token: l.userToken,
      options: { submit: false, expire, force_network: net.force },
      custom_meta: { identifier: a.id, instruction: a.summary.slice(0, 280) },
    }, signedFlag);
    const uuid = sub.created.uuid;
    this.live.set(a.id, uuid);
    approvals.update(a.id, { phone: { uuid, url: sub.created.next?.always, sentAt: new Date().toISOString(), state: "sent" } });
    this.log("xaman: sent", a.id, "to", l.account);
    const timeout = new Promise((r) => setTimeout(() => r({ timedOut: true }), (expire + 1) * 60_000).unref?.());
    Promise.race([sub.resolved, timeout]).then((r: any) => this.resolve(a.id, uuid, prepared, r))
      .catch((e) => this.note(a.id, "error", String(e?.message ?? e)));
  }

  private async resolve(id: string, uuid: string, prepared: Prepared<any>, r: any) {
    this.live.delete(id);
    const a = approvals.get(id);
    if (!a || a.status !== "pending") return;                     // finished in the console first
    if (r?.timedOut) return this.note(id, "expired", "the phone request expired — approve in the console or ask again");
    if (!r?.signed) {
      approvals.update(id, { status: "rejected", note: "rejected in Xaman", phone: { ...a.phone!, state: "rejected" } });
      return;
    }
    const net = NETWORK[this.ledger.network];
    const fail = (why: string) => { approvals.update(id, { status: "failed", note: `phone signature refused: ${why}`, phone: { ...a.phone!, state: "error", note: why } }); };
    const p = await this.client.get(uuid);
    if (Number(p?.response?.environment_networkid) !== net.id) return fail(`signed on network ${p?.response?.environment_networkid ?? "?"}, not ${this.ledger.network}`);
    if (p?.response?.account !== (a.intent.input as { account: string }).account) return fail("signed by a different account");
    const hex = p?.response?.hex;
    if (!hex) return fail("Xaman returned no signed transaction");
    const problem = signedBlobProblem(prepared.tx, hex);
    if (problem) return fail(problem);
    approvals.update(id, { phone: { ...a.phone!, state: "signed" } });
    if (a.intent.tool === "x402") { await redeemX402(this.ledger, a, hex); return; }
    const proof = await submitSigned(this.ledger, hex);           // we submit; Xaman only signed
    await finalizeApproval(this.ledger, id, proof.hash);
  }
}
