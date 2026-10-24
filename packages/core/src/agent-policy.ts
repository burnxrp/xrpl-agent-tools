// Agent account spending policy. The REAL cap is the agent account's ledger balance (funded by its owner); this
// policy is defence in depth on top. It can only be changed with the OWNER wallet's signature — so an agent can't
// raise its own limits, even if it can reach the local console API.
import { deriveAddress, sign, verify, deriveKeypair } from "ripple-keypairs";
import { convertStringToHex } from "xrpl";
import type { Asset } from "./tools/payment.js";

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

export const assetKey = (a: Asset): string => (a === "XRP" ? "XRP" : `${a.currency}:${a.issuer}`);

export interface SpendRequest { asset: Asset; amount: string; destination?: string }   // no destination = a trade

/** spentToday = amount of this asset already spent in the last 24 h (rolling). */
export function checkSpend(policy: AgentPolicy, spentToday: number, req: SpendRequest): { ok: boolean; why?: string } {
  const amt = Number(req.amount);
  if (!(amt > 0)) return { ok: false, why: "amount must be positive" };
  if (req.destination && req.destination !== policy.owner && policy.allowedDestinations.length && !policy.allowedDestinations.includes(req.destination))
    return { ok: false, why: "destination is not on this agent's allowlist" };
  const lim = req.asset === "XRP" ? policy.xrp : policy.tokens[assetKey(req.asset)];
  if (!lim) return { ok: false, why: `this agent may not spend ${assetKey(req.asset)} (not in its policy)` };
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

export function verifyPolicy(agentAddress: string, p: AgentPolicy, publicKey: string, signature: string): boolean {
  try {
    return deriveAddress(publicKey) === p.owner && verify(policyMessageHex(agentAddress, p), signature, publicKey);
  } catch { return false; }
}
