// Submission and ledger proof. "Done" means a VALIDATED ledger says tesSUCCESS — not that a node accepted it.
import { hashes, convertHexToString } from "xrpl";
import type { Ledger } from "../ledger.js";
import { explorerTx } from "../networks.js";

export interface LedgerProof {
  hash: string;
  validated: boolean;
  result: string;             // e.g. tesSUCCESS, tecNO_DST …
  success: boolean;
  ledgerIndex?: number;
  type?: string;
  explorer: string;
  /** For EscrowCreate: the reference needed to finish/cancel it later. */
  escrow?: { owner: string; sequence: number };
  /** For Payment: what actually arrived (from the ledger metadata, not the request). */
  delivered?: string;
}

/** Submit an already-signed blob (signed by the user's wallet) and wait for validation. */
export async function submitSigned(ledger: Ledger, txBlob: string): Promise<LedgerProof> {
  const c = await ledger.client();
  const hash = hashes.hashSignedTx(txBlob);
  try {
    await c.submitAndWait(txBlob);
  } catch (e) {
    // submitAndWait throws on tec/tef results too — the ledger lookup below tells the truth either way
    const p = await verifyTx(ledger, hash).catch(() => null);
    if (p) return p;
    throw e;
  }
  return verifyTx(ledger, hash);
}

/** Look a transaction up and report what the validated ledger says. */
export async function verifyTx(ledger: Ledger, hash: string): Promise<LedgerProof> {
  const r = await ledger.request<any>({ command: "tx", transaction: hash });
  const tx = r.tx_json ?? r;
  const result = r.meta?.TransactionResult ?? "unknown";
  const proof: LedgerProof = {
    hash, validated: !!r.validated, result, success: !!r.validated && result === "tesSUCCESS",
    ledgerIndex: r.ledger_index, type: tx.TransactionType, explorer: explorerTx(ledger.network, hash),
  };
  if (tx.TransactionType === "Payment" && proof.success) {
    const d = r.meta?.delivered_amount;
    proof.delivered = typeof d === "string" ? `${Number(d) / 1e6} XRP`
      : d ? `${d.value} ${d.currency.length === 40 ? convertHexToString(d.currency).replace(/\0+$/, "") : d.currency}` : undefined;
  }
  if (tx.TransactionType === "EscrowCreate" && proof.success) {
    proof.escrow = { owner: tx.Account, sequence: Number(tx.Sequence || tx.TicketSequence) };
  }
  return proof;
}
