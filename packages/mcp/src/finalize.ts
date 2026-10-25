// Close an approval from a transaction hash: the ledger must have validated it, and it must be exactly what was
// approved. Used by the console's /result route and the Xaman phone bridge alike.
import { Ledger, verifyTx, matchesIntent } from "@xrpl-agent/core";
import { approvals, type Approval } from "./approvals.js";

export async function finalizeApproval(ledger: Ledger, id: string, hash: string): Promise<{ ok: boolean; approval: Approval }> {
  const a = approvals.get(id);
  if (!a) throw new Error("unknown approval");
  if (a.status !== "pending") return { ok: false, approval: a };
  if (!/^[0-9A-F]{64}$/i.test(String(hash))) throw new Error("bad hash");
  const proof = await verifyTx(ledger, hash);
  const tx = await ledger.request<any>({ command: "tx", transaction: hash });
  const match = matchesIntent(a.intent, tx.tx_json ?? tx);
  if (!match.ok) return { ok: false, approval: approvals.update(a.id, { status: "failed", hash, proof, note: `does not match approval: ${match.why}` })! };
  return { ok: proof.success, approval: approvals.update(a.id, { status: proof.success ? "confirmed" : "failed", hash, proof })! };
}
