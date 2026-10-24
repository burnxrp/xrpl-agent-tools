// Agent accounts: separately funded XRPL accounts the agent can spend from WITHOUT per-transaction approval.
// Exposure is capped by the account's ledger balance (whatever the owner funded it with). Keys are generated and
// encrypted here, on the agent's machine; no tool ever returns them. Spending rules are owner-signed (agent-policy).
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { Wallet } from "xrpl";
import {
  Ledger, type AgentPolicy, type Asset, defaultPolicy, checkSpend, assetKey, verifyPolicy,
  preparePayment, submitSigned, signLocally, getAccount, type LedgerProof, prepareSwap,
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

/** Send funds back to the owner — always allowed, never counted against limits. Default: everything spendable. */
export async function returnToOwner(ledger: Ledger, address: string, amount?: string): Promise<LedgerProof> {
  const s = read(address);
  const acct = await getAccount(ledger, address);
  const amt = amount ?? String(Math.max(0, Math.floor((Number(acct.spendableXrp) - 0.0001) * 1e6) / 1e6));
  if (!(Number(amt) > 0)) throw new Error("nothing spendable to return (the reserve stays locked while the account exists)");
  return agentPay(ledger, address, { destination: s.policy.owner, amount: amt, asset: "XRP", memo: "return to owner" });
}

/** Owner-signed policy update (from the console). */
export function updatePolicy(address: string, policy: AgentPolicy, publicKey: string, signature: string): AgentPolicy {
  const s = read(address);
  if (policy.owner !== s.policy.owner) throw new Error("the owner can't be changed");
  if (!(policy.version > s.policy.version)) throw new Error(`policy version must be greater than ${s.policy.version}`);
  if (!verifyPolicy(address, policy, publicKey, signature)) throw new Error("not signed by the owner wallet");
  write({ ...s, policy });
  return policy;
}
