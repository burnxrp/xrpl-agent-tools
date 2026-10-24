// Agent accounts: separately funded XRPL accounts the agent can spend from WITHOUT per-transaction approval.
// Exposure is capped by the account's ledger balance (whatever the owner funded it with). Keys are generated and
// encrypted here, on the agent's machine; no tool ever returns them. Spending rules are owner-signed (agent-policy).
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { Wallet, type TrustSet } from "xrpl";
import {
  Ledger, type AgentPolicy, type Asset, defaultPolicy, checkSpend, assetKey, verifyPolicy,
  preparePayment, submitSigned, signLocally, getAccount, type LedgerProof, prepareSwap, verifyPolicyProof, validatePolicy, displayKey,
  x402Challenge, x402Redeem, selectRequirement, transferMethod, prepareX402Payment, requirementAsset, requirementValue, verifyTx,
  listTickets, prepareTicketCreate, prepareTicketRelease, type X402FetchResult,
} from "@xrpl-agent/core";

const HOME = process.env.XRPL_AGENT_HOME || join(homedir(), ".xrpl-agent");
const DIR = join(HOME, "agents");

interface Stored {
  address: string; network: string; label: string; createdAt: string;
  policy: AgentPolicy; enc: { salt: string; iv: string; tag: string; data: string };
}
export interface SpendEntry { at: string; hash: string; asset: string; amount: string; destination: string; result: string; kind: "spend" | "return" }

// ── key protection ───────────────────────────────────────────────────────────
function masterSecret(): Buffer {
  if (process.env.XRPL_AGENT_PASSPHRASE) return Buffer.from(process.env.XRPL_AGENT_PASSPHRASE, "utf8");
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const f = join(DIR, ".machine-key");
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(readFileSync(f, "utf8").trim(), "hex");
}
function seal(seed: string) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(masterSecret(), salt, 32);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(seed, "utf8"), c.final()]);
  return { salt: salt.toString("hex"), iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("hex") };
}
function unseal(e: Stored["enc"]): string {
  const key = scryptSync(masterSecret(), Buffer.from(e.salt, "hex"), 32);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "hex"));
  d.setAuthTag(Buffer.from(e.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(e.data, "hex")), d.final()]).toString("utf8");
}

// ── storage ──────────────────────────────────────────────────────────────────
const file = (a: string) => join(DIR, `${a}.json`);
const logFile = (a: string) => join(DIR, `${a}.spend.jsonl`);
function write(s: Stored) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file(s.address) + ".tmp", JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(file(s.address) + ".tmp", file(s.address));
}
function read(address: string): Stored {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address) || !existsSync(file(address))) throw new Error(`no agent account ${address} on this machine`);
  return JSON.parse(readFileSync(file(address), "utf8"));
}
export function listAgents(network: string): Omit<Stored, "enc">[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => /^r\w+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Stored)
    .filter((s) => s.network === network).map(({ enc: _e, ...pub }) => pub);
}
export function spendLog(address: string): SpendEntry[] {
  try { return readFileSync(logFile(address), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export function spentLast24h(address: string, key: string): number {
  const since = Date.now() - 86_400_000;
  return spendLog(address).filter((e) => e.kind === "spend" && e.asset === key && Date.parse(e.at) > since && e.result !== "refused")
    .reduce((s, e) => s + Number(e.amount), 0);
}

// one spend at a time per agent account (no racing past the daily limit)
const locks = new Map<string, Promise<unknown>>();
async function serial<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(address) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(address, next.catch(() => {}));
  return next;
}

// ── operations ───────────────────────────────────────────────────────────────
export async function createAgent(ledger: Ledger, owner: string, label: string, faucet: boolean) {
  await getAccount(ledger, owner);                               // validates the owner address
  const w = Wallet.generate();
  const s: Stored = { address: w.classicAddress, network: ledger.network, label: label || "agent", createdAt: new Date().toISOString(),
                      policy: defaultPolicy(owner), enc: seal(w.seed!) };
  write(s);
  if (faucet) {
    if (ledger.network === "mainnet") throw new Error("no faucet on mainnet — fund the agent account from the owner's wallet");
    const c = await ledger.client();
    await c.fundWallet(w);
  }
  return { address: s.address, owner, label: s.label, policy: s.policy };
}

export async function agentStatus(ledger: Ledger, address: string) {
  const s = read(address);
  const acct = await getAccount(ledger, address);
  const spent: Record<string, number> = { XRP: spentLast24h(address, "XRP") };
  for (const k of Object.keys(s.policy.tokens)) spent[k] = spentLast24h(address, k);
  return { address, label: s.label, owner: s.policy.owner, network: s.network,
           exposureCapXrp: acct.spendableXrp, balanceXrp: acct.balanceXrp, activated: acct.exists,
           policy: s.policy, spentLast24h: spent, recent: spendLog(address).slice(-10).reverse() };
}

function record(address: string, e: SpendEntry) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  appendFileSync(logFile(address), JSON.stringify(e) + "\n", { mode: 0o600 });
}

/** Autonomous spend: policy check → native payment → signed with the agent key → validated proof. No human step. */
export function agentPay(ledger: Ledger, from: string, req: { destination: string; amount: string; asset: Asset;
                                                                destinationTag?: number; memo?: string }): Promise<LedgerProof> {
  return serial(from, async () => {
    const s = read(from);
    const key = assetKey(req.asset);
    if (req.destination !== s.policy.owner) {   // returning funds to the owner is always allowed and never limited
      const verdict = checkSpend(s.policy, spentLast24h(from, key), { asset: req.asset, amount: req.amount, destination: req.destination });
      if (!verdict.ok) throw new Error(`policy refused: ${verdict.why}`);
    }
    const p = await preparePayment(ledger, { account: from, ...req });
    const proof = await submitSigned(ledger, signLocally(unseal(s.enc), p.tx).txBlob);
    record(from, { at: new Date().toISOString(), hash: proof.hash, asset: key, amount: req.amount, destination: req.destination,
                   result: proof.result, kind: req.destination === s.policy.owner ? "return" : "spend" });
    return proof;
  });
}

/** Autonomous swap from the agent account. The amount SOLD counts against the owner's limits for that asset. */
export function agentSwap(ledger: Ledger, from: string, req: { sell: Asset; amount: string; buy: Asset; slippagePct?: number }): Promise<LedgerProof> {
  return serial(from, async () => {
    const s = read(from);
    const key = assetKey(req.sell);
    const verdict = checkSpend(s.policy, spentLast24h(from, key), { asset: req.sell, amount: req.amount });
    if (!verdict.ok) throw new Error(`policy refused: ${verdict.why}`);
    const p = await prepareSwap(ledger, { account: from, ...req, slippagePct: Math.min(req.slippagePct ?? 1, 5) });
    const proof = await submitSigned(ledger, signLocally(unseal(s.enc), p.tx).txBlob);
    if (proof.success) record(from, { at: new Date().toISOString(), hash: proof.hash, asset: key, amount: req.amount,
                                      destination: "swap", result: proof.result, kind: "spend" });
    return proof;
  });
}

/** Open a trustline so the agent can hold a token — only for tokens the owner's policy lists (costs reserve, not funds). */
export function agentTrustline(ledger: Ledger, from: string, token: { currency: string; issuer: string }): Promise<LedgerProof> {
  return serial(from, async () => {
    const s = read(from);
    const key = assetKey(token);
    if (!s.policy.tokens[key]) throw new Error(`policy refused: ${displayKey(key)} is not in this agent's token limits — the owner must add it first`);
    const c = await ledger.client();
    const [currency, issuer] = key.split(":");
    const tx = await c.autofill<TrustSet>({ TransactionType: "TrustSet", Account: from, Flags: 0x00020000 /* tfSetNoRipple */,
      LimitAmount: { currency, issuer, value: "1000000000000000" } });
    return submitSigned(ledger, signLocally(unseal(s.enc), tx).txBlob);
  });
}

// ── x402 ─────────────────────────────────────────────────────────────────────
// "sequence" offers: the whole payment (sign → seller settles) holds the account's lock — one pending payment at a time,
// as the spec asks. "ticketSequence" offers: only policy check + ticket pick + signing hold the lock; the HTTP round
// trip runs outside it, so several paid requests can be pending at once (one ticket each).
export const MAX_AGENT_TICKETS = 10;
const TICKET_BATCH = 3;
const ticketHolds = new Map<string, Map<number, number>>();   // agent → ticket → LastLedgerSequence of the blob using it

async function freeTickets(ledger: Ledger, from: string): Promise<{ all: number[]; free: number[]; validated: number }> {
  const validated = Number((await ledger.request<any>({ command: "ledger", ledger_index: "validated" })).ledger_index);
  const holds = ticketHolds.get(from) ?? new Map<number, number>();
  for (const [t, lls] of holds) if (lls < validated) holds.delete(t);
  ticketHolds.set(from, holds);
  const all = await listTickets(ledger, from);
  return { all, free: all.filter((t) => !holds.has(t)), validated };
}

/** Must be called inside serial(from). Creates tickets when none are free (bounded by MAX_AGENT_TICKETS). */
async function takeTicket(ledger: Ledger, from: string, seed: string): Promise<number> {
  let { all, free } = await freeTickets(ledger, from);
  if (!free.length) {
    const count = Math.min(TICKET_BATCH, MAX_AGENT_TICKETS - all.length);
    if (count < 1) throw new Error(`all ${all.length} tickets are in use by pending payments — wait for them to settle or expire`);
    const p = await prepareTicketCreate(ledger, { account: from, count });
    const proof = await submitSigned(ledger, signLocally(seed, p.tx).txBlob);
    if (!proof.success) throw new Error(`couldn't create tickets: ${proof.result}`);
    ({ all, free } = await freeTickets(ledger, from));
    if (!free.length) throw new Error("no ticket available after TicketCreate");
  }
  ticketHolds.get(from)!.set(free[0], Number.MAX_SAFE_INTEGER);   // held until we know the blob's expiry
  return free[0];
}

export function agentTicketStatus(ledger: Ledger, from: string) {
  read(from);
  return freeTickets(ledger, from).then(({ all, free }) => ({ tickets: all, free, inUse: all.filter((t) => !free.includes(t)), max: MAX_AGENT_TICKETS }));
}

export function agentTickets(ledger: Ledger, from: string, op: { create?: number; releaseUnused?: boolean }) {
  return serial(from, async () => {
    const s = read(from), seed = unseal(s.enc);
    const out: { created?: LedgerProof; released: LedgerProof[] } = { released: [] };
    if (op.create) {
      const { all } = await freeTickets(ledger, from);
      if (all.length + op.create > MAX_AGENT_TICKETS) throw new Error(`at most ${MAX_AGENT_TICKETS} tickets per agent account (has ${all.length})`);
      out.created = await submitSigned(ledger, signLocally(seed, (await prepareTicketCreate(ledger, { account: from, count: op.create })).tx).txBlob);
    }
    if (op.releaseUnused) {
      const { free } = await freeTickets(ledger, from);
      for (const t of free) out.released.push(await submitSigned(ledger, signLocally(seed, (await prepareTicketRelease(ledger, { account: from, ticket: t })).tx).txBlob));
    }
    return { ...out, ...(await agentTicketStatus(ledger, from)) };
  });
}

/** Pay-per-request with x402: fetch `url`; if it answers 402, pay it from the agent account — only if the price fits the
 *  owner's policy (per-tx / 24 h limits for that asset, destination allowlist on payTo) and the agent's own cap. The
 *  signed amount is logged as spent the moment it's signed (conservative: it counts even if the seller never settles). */
export async function agentX402Fetch(ledger: Ledger, from: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: string },
                                     maxAmount?: string, opts: { useTickets?: boolean } = {}): Promise<X402FetchResult & { proof?: LedgerProof }> {
  read(from);
  const reqInit = { method: init.method ?? "GET", headers: init.headers, body: init.body };
  const first = await x402Challenge(url, reqInit);
  if (!first.paymentRequired) return first;
  const pr = first.paymentRequired;
  const r = selectRequirement(pr, ledger.network as any, { tickets: true, prefer: opts.useTickets ? "ticketSequence" : "sequence" });
  const ticketMode = transferMethod(r) === "ticketSequence";

  const signPayment = async (): Promise<string> => {        // runs inside serial(from)
    const s = read(from);
    const asset = requirementAsset(r), amount = requirementValue(r), key = assetKey(asset);
    if (maxAmount !== undefined && Number(amount) > Number(maxAmount)) throw new Error(`price ${amount} ${displayKey(key)} is above your max_amount ${maxAmount}`);
    const verdict = checkSpend(s.policy, spentLast24h(from, key), { asset, amount, destination: r.payTo });
    if (!verdict.ok) throw new Error(`policy refused: ${verdict.why}`);
    const seed = unseal(s.enc);
    const ticket = ticketMode ? await takeTicket(ledger, from, seed) : undefined;
    try {
      const p = await prepareX402Payment(ledger, from, r, { ticket });
      const blob = signLocally(seed, p.tx).txBlob;
      if (ticket !== undefined) ticketHolds.get(from)!.set(ticket, Number(p.tx.LastLedgerSequence));
      record(from, { at: new Date().toISOString(), hash: "", asset: key, amount, destination: r.payTo,
                     result: ticketMode ? "x402-signed (ticket)" : "x402-signed", kind: "spend" });
      return blob;
    } catch (e) { if (ticket !== undefined) ticketHolds.get(from)!.delete(ticket); throw e; }
  };

  const out = ticketMode
    ? await x402Redeem(url, reqInit, r, await serial(from, signPayment), pr.resource)                       // lock only while signing
    : await serial(from, async () => x402Redeem(url, reqInit, r, await signPayment(), pr.resource));       // one pending at a time
  let proof: LedgerProof | undefined;
  for (let i = 0; i < 8 && !proof?.validated; i++) {           // the seller settles; confirm on the ledger ourselves
    try { proof = await verifyTx(ledger, out.paid!.txHash); } catch { /* not seen yet */ }
    if (!proof?.validated) await new Promise((res) => setTimeout(res, 1500));
  }
  return { ...out, proof };
}

/** Send funds back to the owner — always allowed, never counted against limits. Default: everything spendable. */
export async function returnToOwner(ledger: Ledger, address: string, amount?: string): Promise<LedgerProof> {
  const s = read(address);
  const acct = await getAccount(ledger, address);
  const amt = amount ?? String(Math.max(0, Math.floor((Number(acct.spendableXrp) - 0.0001) * 1e6) / 1e6));
  if (!(Number(amt) > 0)) throw new Error("nothing spendable to return (the reserve stays locked while the account exists)");
  return agentPay(ledger, address, { destination: s.policy.owner, amount: amt, asset: "XRP", memo: "return to owner" });
}

/** Owner-signed policy update (from the console): a message signature (local wallet) or a never-applicable signed
 *  approval transaction (extension wallets). */
export function updatePolicy(address: string, policy: AgentPolicy,
                             auth: { publicKey?: string; signature?: string; proofTx?: string }): AgentPolicy {
  const s = read(address);
  if (policy.owner !== s.policy.owner) throw new Error("the owner can't be changed");
  if (!(policy.version > s.policy.version)) throw new Error(`policy version must be greater than ${s.policy.version}`);
  const errs = validatePolicy(policy);
  if (errs.length) throw new Error(`invalid policy: ${errs.join("; ")}`);
  if (auth.proofTx) {
    const v = verifyPolicyProof(address, policy, auth.proofTx);
    if (!v.ok) throw new Error(`not approved by the owner wallet: ${v.why}`);
  } else if (!auth.publicKey || !auth.signature || !verifyPolicy(address, policy, auth.publicKey, auth.signature))
    throw new Error("not signed by the owner wallet");
  write({ ...s, policy });
  return policy;
}
