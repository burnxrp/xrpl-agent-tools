// Agent account spending policy. The REAL cap is the agent account's ledger balance (funded by its owner); this
// policy is defence in depth on top. It can only be changed with the OWNER wallet's signature — so an agent can't
// raise its own limits, even if it can reach the local console API.
import { deriveAddress, sign, verify, deriveKeypair } from "ripple-keypairs";
import { convertStringToHex, decode, verifySignature, type AccountSet } from "xrpl";
import { currencyCode, type Asset } from "./tools/payment.js";
import { isValidClassicAddress } from "xrpl";
import { displayCurrency } from "./amounts.js";

export interface AssetLimit { perTx: string; daily: string }

export interface AgentPolicy {
  owner: string;                         // the human wallet that funds the account and controls this policy
  xrp: AssetLimit;
  tokens: Record<string, AssetLimit>;    // "CURRENCY:rIssuer" → limits; tokens not listed are not spendable
  allowedDestinations: string[];         // empty = any destination
  version: number;                       // must increase with every signed update (no replaying old policies)
}

export const defaultPolicy = (owner: string): AgentPolicy =>
  ({ owner, xrp: { perTx: "10", daily: "25" }, tokens: {}, allowedDestinations: [], version: 1 });

/** Canonical key: "XRP" or "<ledger currency code>:<issuer>" ("USD:r…", or 40-hex for longer names). */
export const assetKey = (a: Asset): string => (a === "XRP" ? "XRP" : `${currencyCode(a.currency)}:${a.issuer}`);
export function parseAssetKey(key: string): Asset {
  if (key === "XRP") return "XRP";
  const [currency, issuer] = key.split(":");
  return { currency, issuer };
}

const LIMIT = /^\d{1,15}(\.\d{1,15})?$/;
export const MAX_POLICY_TOKENS = 50, MAX_POLICY_DESTINATIONS = 200;

/** Everything wrong with a policy (empty = valid). Run by the adapter before accepting any signed update. */
export function validatePolicy(p: AgentPolicy): string[] {
  const errs: string[] = [];
  const limit = (l: AssetLimit | undefined, what: string) => {
    if (!l || !LIMIT.test(String(l.perTx)) || !LIMIT.test(String(l.daily))) return errs.push(`${what}: limits must be plain positive numbers`);
    if (!(Number(l.perTx) > 0) || !(Number(l.daily) > 0)) errs.push(`${what}: limits must be greater than 0`);
    if (Number(l.perTx) > Number(l.daily)) errs.push(`${what}: per-transaction limit is above the 24-hour limit`);
  };
  if (!isValidClassicAddress(p.owner)) errs.push("owner is not a valid address");
  if (!Number.isInteger(p.version) || p.version < 1) errs.push("version must be a positive integer");
  limit(p.xrp, "XRP");
  const keys = Object.keys(p.tokens ?? {});
  if (keys.length > MAX_POLICY_TOKENS) errs.push(`at most ${MAX_POLICY_TOKENS} tokens`);
  for (const k of keys) {
    const a = parseAssetKey(k);
    let canonical = "";
    try { canonical = a === "XRP" ? "" : assetKey(a); } catch { /* bad code */ }
    if (a === "XRP" || !isValidClassicAddress(a.issuer) || canonical !== k) { errs.push(`token "${k}" is not a valid CURRENCY:issuer key`); continue; }
    limit(p.tokens[k], displayKey(k));
  }
  const d = p.allowedDestinations ?? [];
  if (d.length > MAX_POLICY_DESTINATIONS) errs.push(`at most ${MAX_POLICY_DESTINATIONS} allowed destinations`);
  for (const x of d) if (!isValidClassicAddress(x)) errs.push(`allowed destination "${x}" is not a valid address`);
  if (new Set(d).size !== d.length) errs.push("allowed destinations contain duplicates");
  return errs;
}

/** "USD:rIssuer" → "USD (rIssu…)" for people. */
export function displayKey(k: string): string {
  const a = parseAssetKey(k);
  if (a === "XRP") return "XRP";
  return `${displayCurrency(a.currency)} (${a.issuer.slice(0, 6)}…)`;
}

export interface SpendRequest { asset: Asset; amount: string; destination?: string }   // no destination = a trade

/** spentToday = amount of this asset already spent in the last 24 h (rolling). */
export function checkSpend(policy: AgentPolicy, spentToday: number, req: SpendRequest): { ok: boolean; why?: string } {
  const amt = Number(req.amount);
  if (!(amt > 0)) return { ok: false, why: "amount must be positive" };
  if (req.destination && req.destination !== policy.owner && policy.allowedDestinations.length && !policy.allowedDestinations.includes(req.destination))
    return { ok: false, why: "destination is not on this agent's allowlist" };
  const lim = req.asset === "XRP" ? policy.xrp : policy.tokens[assetKey(req.asset)];
  if (!lim) return { ok: false, why: `this agent may not spend ${displayKey(assetKey(req.asset))} (not in its token limits)` };
  if (amt > Number(lim.perTx)) return { ok: false, why: `over the per-transaction limit (${lim.perTx})` };
  if (spentToday + amt > Number(lim.daily))
    return { ok: false, why: `over the 24-hour limit (${lim.daily}; already spent ${+spentToday.toFixed(6)})` };
  return { ok: true };
}

/** The exact bytes an owner signs to authorize a policy for a given agent account. */
export function policyMessageHex(agentAddress: string, p: AgentPolicy): string {
  const canonical = JSON.stringify({ agent: agentAddress, owner: p.owner, version: p.version, xrp: p.xrp,
    tokens: Object.fromEntries(Object.entries(p.tokens).sort()), allowedDestinations: [...p.allowedDestinations].sort() });
  return convertStringToHex("XRPL-AGENT-POLICY:" + canonical);
}

export function signPolicy(ownerSeed: string, agentAddress: string, p: AgentPolicy): { publicKey: string; signature: string } {
  const kp = deriveKeypair(ownerSeed);
  if (deriveAddress(kp.publicKey) !== p.owner) throw new Error("only the owner wallet can sign this agent's policy");
  return { publicKey: kp.publicKey, signature: sign(policyMessageHex(agentAddress, p), kp.privateKey) };
}

// ── Policy approval as a signed transaction (browser-extension wallets: GemWallet, Crossmark) ─────────────────────
// Extension wallets sign transactions, not arbitrary messages, in a uniform way. So the owner signs an AccountSet that
// carries the policy text in a memo (readable in the wallet) and can NEVER be applied: LastLedgerSequence 1 is billions of ledgers in the past,
// so any node rejects it (tefMAX_LEDGER). It is only ever used as a signature, never submitted.
const PROOF_MEMO_TYPE = convertStringToHex("xrpl-agent/policy");

export function policyProofTx(agentAddress: string, p: AgentPolicy, sequence: number): AccountSet {
  return { TransactionType: "AccountSet", Account: p.owner, Fee: "12", Sequence: sequence, LastLedgerSequence: 1,
    Memos: [{ Memo: { MemoType: PROOF_MEMO_TYPE, MemoData: policyMessageHex(agentAddress, p) } }] };
}

export function verifyPolicyProof(agentAddress: string, p: AgentPolicy, txBlob: string): { ok: boolean; why?: string } {
  let tx: Record<string, any>;
  try { tx = decode(txBlob) as Record<string, any>; } catch { return { ok: false, why: "not a transaction" }; }
  const memo = tx.Memos?.[0]?.Memo;
  if (tx.TransactionType !== "AccountSet" || tx.Account !== p.owner) return { ok: false, why: "not signed by the owner's account" };
  if (!(Number(tx.LastLedgerSequence) >= 1 && Number(tx.LastLedgerSequence) <= 1000))
    return { ok: false, why: "the wallet changed LastLedgerSequence, so this could be applied on the ledger — refused" };
  if (tx.SetFlag !== undefined || tx.ClearFlag !== undefined || tx.Domain || tx.TransferRate || tx.EmailHash || tx.MessageKey || tx.NFTokenMinter
      || tx.TickSize || tx.WalletLocator || tx.Memos?.length !== 1) return { ok: false, why: "carries more than the policy approval" };
  if (memo?.MemoType?.toUpperCase() !== PROOF_MEMO_TYPE.toUpperCase() || memo?.MemoData?.toUpperCase() !== policyMessageHex(agentAddress, p).toUpperCase())
    return { ok: false, why: "signed a different policy" };
  try {
    if (deriveAddress(tx.SigningPubKey) !== p.owner) return { ok: false, why: "signed with a regular key — sign with the owner's master key" };
    if (!verifySignature(txBlob)) return { ok: false, why: "bad signature" };
  } catch { return { ok: false, why: "bad signature" }; }
  return { ok: true };
}

export function verifyPolicy(agentAddress: string, p: AgentPolicy, publicKey: string, signature: string): boolean {
  try {
    return deriveAddress(publicKey) === p.owner && verify(policyMessageHex(agentAddress, p), signature, publicKey);
  } catch { return false; }
}
