// What a human approves is an INTENT (tool + arguments), not a byte string: transactions expire within ~a minute
// (LastLedgerSequence), so the wallet re-prepares at approval time. matchesIntent() proves afterwards that what
// actually landed on the ledger is exactly what was approved.
import { xrpToDrops } from "xrpl";
import type { EscrowCreateInput, EscrowRef } from "./tools/escrow.js";
import { currencyCode, type PaymentInput } from "./tools/payment.js";

export type Intent =
  | { tool: "escrow_create"; input: EscrowCreateInput & { finishAfterRipple?: number; cancelAfterRipple?: number } }
  | { tool: "escrow_finish"; input: EscrowRef & { account: string } }
  | { tool: "escrow_cancel"; input: EscrowRef & { account: string } }
  | { tool: "payment"; input: PaymentInput };

export function matchesIntent(intent: Intent, tx: Record<string, any>): { ok: boolean; why?: string } {
  const must = (cond: boolean, why: string) => (cond ? null : why);
  const i: any = intent.input;
  const sameAmount = (a: any) => i.asset === "XRP" ? String(a) === xrpToDrops(i.amount)
    : typeof a === "object" && a.currency === currencyCode(i.asset.currency) && a.issuer === i.asset.issuer && Number(a.value) === Number(i.amount);
  const checks: (string | null)[] =
    intent.tool === "payment" ? [
      must(tx.TransactionType === "Payment", "not a Payment"),
      must(tx.Account === i.account, "different sender"),
      must(tx.Destination === i.destination, "different destination"),
      // API v2 reports a validated Payment's amount as DeliverMax (Amount is the v1 name) — accept either.
      must(sameAmount(tx.Amount ?? tx.DeliverMax), "different amount or currency"),
      must(!((Number(tx.Flags) || 0) & 0x00020000), "partial payment flag set"),
      must(i.destinationTag === undefined || tx.DestinationTag === i.destinationTag, "different destination tag"),
    ] :
    intent.tool === "escrow_create" ? [
      must(tx.TransactionType === "EscrowCreate", "not an EscrowCreate"),
      must(tx.Account === i.account, "different sender"),
      must(tx.Destination === i.destination, "different destination"),
      must(String(tx.Amount) === xrpToDrops(i.amount), "different amount"),
      must(i.finishAfterRipple === undefined || tx.FinishAfter === i.finishAfterRipple, "different release time"),
      must(i.cancelAfterRipple === undefined || tx.CancelAfter === i.cancelAfterRipple, "different cancel time"),
    ] : [
      must(tx.TransactionType === (intent.tool === "escrow_finish" ? "EscrowFinish" : "EscrowCancel"), "wrong transaction type"),
      must(tx.Account === i.account, "different signer"),
      must(tx.Owner === i.owner && Number(tx.OfferSequence) === Number(i.sequence), "different escrow"),
    ];
  const why = checks.find((c) => c);
  return why ? { ok: false, why } : { ok: true };
}
