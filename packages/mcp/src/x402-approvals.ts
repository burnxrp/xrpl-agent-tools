// x402 paid requests from a HUMAN wallet: the agent asks, the human approves in the console, the human's wallet signs,
// and this adapter (not the browser) hands the signed payment to the seller and keeps the response for the agent.
//  1. request: fetch the URL; if it's a 402, queue an approval "pay at most P of A to S for METHOD url".
//  2. quote (at approval time): re-fetch for a FRESH requirement — invoices expire — and accept it only if the payee
//     and asset are the same and the price is not higher than what the human is approving.
//  3. redeem: check the signed blob against that quote (x402TxProblem + signature + sender), send it to the seller,
//     confirm the payment on the ledger ourselves, store the seller's response on the approval.
import { decode, verifySignature } from "xrpl";
import {
  Ledger, x402Challenge, x402Redeem, selectRequirement, requirementAsset, requirementValue, x402TxProblem, matchesIntent,
  transferMethod, verifyTx, assetKey, type X402Requirements, type X402ResourceInfo, type LedgerProof, type Asset,
} from "@xrpl-agent/core";
import { approvals, type Approval } from "./approvals.js";

const quotes = new Map<string, { req: X402Requirements; resource?: X402ResourceInfo; at: number }>();
const clip = (s: string) => (s.length > 20_000 ? s.slice(0, 20_000) + `… [${s.length - 20_000} more chars]` : s);
const label = (a: Asset, amount: string) => `${amount} ${a === "XRP" ? "XRP" : a.currency}`;

export interface X402Request { account: string; url: string; method?: string; headers?: Record<string, string>; body?: string; maxAmount?: string }

/** Returns either the plain response (no payment needed) or a queued approval. */
export async function requestX402Approval(ledger: Ledger, r: X402Request):
    Promise<{ response: { status: number; body: string; contentType?: string } } | { approval: Approval }> {
  const method = r.method ?? "GET";
  const first = await x402Challenge(r.url, { method, headers: r.headers, body: r.body });
  if (!first.paymentRequired) return { response: { status: first.status, body: clip(first.body), contentType: first.headers["content-type"] } };
  const pr = first.paymentRequired;
  const req = selectRequirement(pr, ledger.network);
  const asset = requirementAsset(req), amount = requirementValue(req);
  if (r.maxAmount !== undefined && Number(amount) > Number(r.maxAmount)) throw new Error(`price ${label(asset, amount)} is above max_amount ${r.maxAmount}`);
  const seller = pr.resource?.serviceName || pr.resource?.description;
  return { approval: approvals.add({
    network: ledger.network,
    intent: { tool: "x402", input: { account: r.account, url: r.url, method, payTo: req.payTo, asset, amount, headers: r.headers, body: r.body } },
    summary: `Pay ${label(asset, amount)} to ${req.payTo} for ${method} ${r.url}`,
    details: { url: r.url, method, payee: req.payTo, price: label(asset, amount), ...(seller ? { seller: String(seller).slice(0, 120) } : {}),
               sequencing: transferMethod(req) === "ticketSequence" ? "XRPL Ticket" : "account sequence",
               ...(r.body ? { requestBody: `${r.body.length} chars` } : {}) },
    warnings: ["The seller is paid only after you sign. The price is re-checked when you approve and can't go up.",
               ...(transferMethod(req) === "ticketSequence" ? ["This seller requires an XRPL Ticket on your account."] : [])],
  }) };
}

/** Fresh requirement for an approval (called when the human clicks Approve). */
export async function quoteX402(ledger: Ledger, a: Approval): Promise<X402Requirements> {
  if (a.intent.tool !== "x402") throw new Error("not an x402 approval");
  const i = a.intent.input;
  const first = await x402Challenge(i.url, { method: i.method, headers: i.headers, body: i.body });
  if (!first.paymentRequired) throw new Error(`the resource no longer asks for payment (HTTP ${first.status})`);
  const req = selectRequirement(first.paymentRequired, ledger.network);
  if (req.payTo !== i.payTo) throw new Error(`the seller's payee changed (${req.payTo}) — not paying; ask the agent to request again`);
  if (assetKey(requirementAsset(req)) !== assetKey(i.asset)) throw new Error("the seller now asks for a different asset — not paying");
  if (Number(requirementValue(req)) > Number(i.amount)) throw new Error(`the price went up to ${requirementValue(req)} (approved ${i.amount}) — not paying`);
  quotes.set(a.id, { req, resource: first.paymentRequired.resource, at: Date.now() });
  return req;
}

/** Check the human-signed blob, pay the seller, confirm on the ledger, record the response. */
export async function redeemX402(ledger: Ledger, a: Approval, signedTxBlob: string): Promise<Approval> {
  if (a.intent.tool !== "x402") throw new Error("not an x402 approval");
  const q = quotes.get(a.id);
  if (!q || Date.now() - q.at > q.req.maxTimeoutSeconds * 1000) throw new Error("no current quote — approve again");
  if (typeof signedTxBlob !== "string" || !/^[0-9A-Fa-f]+$/.test(signedTxBlob)) throw new Error("bad signed transaction");
  let tx: Record<string, any>;
  try { tx = decode(signedTxBlob) as Record<string, any>; } catch { throw new Error("bad signed transaction"); }
  const i = a.intent.input;
  if (tx.Account !== i.account) throw new Error("signed by a different account");
  const problem = await x402TxProblem(q.req, tx);
  if (problem) throw new Error(`signed payment doesn't match the quote: ${problem}`);
  const m = matchesIntent(a.intent, tx);
  if (!m.ok) throw new Error(`signed payment doesn't match the approval: ${m.why}`);
  if (!verifySignature(signedTxBlob)) throw new Error("bad signature");
  quotes.delete(a.id);                                        // one redemption per quote
  approvals.update(a.id, { status: "submitted", note: "sent to the seller" });
  const out = await x402Redeem(i.url, { method: i.method, headers: i.headers, body: i.body }, q.req, signedTxBlob, q.resource);
  let proof: LedgerProof | undefined;
  for (let k = 0; k < 8 && !proof?.validated; k++) {
    try { proof = await verifyTx(ledger, out.paid!.txHash); } catch { /* not seen yet */ }
    if (!proof?.validated) await new Promise((r) => setTimeout(r, 1500));
  }
  const ok = !!proof?.validated && proof.success && out.status >= 200 && out.status < 300;
  return approvals.update(a.id, {
    status: ok ? "confirmed" : "failed", hash: out.paid!.txHash, proof,
    response: { status: out.status, contentType: out.headers["content-type"], body: clip(out.body), settlement: out.paid?.settlement },
    note: ok ? undefined : !proof?.validated ? `seller answered HTTP ${out.status}; payment not seen on the ledger (it expires unused)`
      : !proof.success ? `ledger result ${proof.result}` : `paid, but the seller answered HTTP ${out.status}`,
  })!;
}
