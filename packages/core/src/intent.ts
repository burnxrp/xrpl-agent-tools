// What a human approves is an INTENT (tool + arguments), not a byte string: transactions expire within ~a minute
// (LastLedgerSequence), so the wallet re-prepares at approval time. matchesIntent() proves afterwards that what
// actually landed on the ledger is exactly what was approved.
import { xrpToDrops } from "xrpl";
import type { EscrowCreateInput, EscrowRef } from "./tools/escrow.js";
import { currencyCode, type PaymentInput } from "./tools/payment.js";
import { sameAsset, amountValue, toCurrency } from "./amounts.js";
import type { SwapInput, LimitOrderInput } from "./tools/dex.js";
import type { AmmDepositInput, AmmWithdrawInput } from "./tools/amm.js";
import type { ClawbackInput } from "./tools/clawback.js";

export type Intent =
  | { tool: "escrow_create"; input: EscrowCreateInput & { finishAfterRipple?: number; cancelAfterRipple?: number } }
  | { tool: "escrow_finish"; input: EscrowRef & { account: string } }
  | { tool: "escrow_cancel"; input: EscrowRef & { account: string } }
  | { tool: "payment"; input: PaymentInput }
  | { tool: "swap"; input: SwapInput & { minOut: string } }
  | { tool: "limit_order"; input: LimitOrderInput }
  | { tool: "offer_cancel"; input: { account: string; sequence: number } }
  | { tool: "amm_deposit"; input: AmmDepositInput & { amount2: string } }
  | { tool: "amm_withdraw"; input: AmmWithdrawInput }
  | { tool: "clawback_enable"; input: { account: string } }
  | { tool: "clawback"; input: ClawbackInput }
  // x402: pay AT MOST `amount` of `asset` to `payTo` for one request to `url` (the price is re-quoted when approved)
  | { tool: "x402"; input: { account: string; url: string; method: string; payTo: string; asset: PaymentInput["asset"]; amount: string;
                             headers?: Record<string, string>; body?: string } };

export function matchesIntent(intent: Intent, tx: Record<string, any>): { ok: boolean; why?: string } {
  const must = (cond: boolean, why: string) => (cond ? null : why);
  const i: any = intent.input;
  const sameAmount = (a: any) => i.asset === "XRP" ? String(a) === xrpToDrops(i.amount)
    : typeof a === "object" && a.currency === currencyCode(i.asset.currency) && a.issuer === i.asset.issuer && Number(a.value) === Number(i.amount);
  const FOK = 0x00040000, SELL = 0x00080000, flags = Number(tx.Flags) || 0;
  const samePool = () => sameAsset(tx.Asset, i.asset1) && sameAsset(tx.Asset2, i.asset2);
  const checks: (string | null)[] =
    intent.tool === "swap" ? [
      must(tx.TransactionType === "OfferCreate", "not an OfferCreate"),
      must(tx.Account === i.account, "different account"),
      must(sameAsset(tx.TakerGets, i.sell) && amountValue(tx.TakerGets) === Number(i.amount), "different amount sold"),
      must(sameAsset(tx.TakerPays, i.buy) && amountValue(tx.TakerPays) >= Number(i.minOut) * (1 - 1e-9), "lower minimum than approved"),
      must((flags & FOK) !== 0 && (flags & SELL) !== 0, "not a fill-or-kill sell"),
    ] :
    intent.tool === "limit_order" ? [
      must(tx.TransactionType === "OfferCreate", "not an OfferCreate"),
      must(tx.Account === i.account, "different account"),
      must(sameAsset(tx.TakerGets, i.sell) && amountValue(tx.TakerGets) === Number(i.sellAmount), "different amount sold"),
      must(sameAsset(tx.TakerPays, i.buy) && amountValue(tx.TakerPays) === Number(i.buyAmount), "different price"),
    ] :
    intent.tool === "offer_cancel" ? [
      must(tx.TransactionType === "OfferCancel", "not an OfferCancel"),
      must(tx.Account === i.account && Number(tx.OfferSequence) === Number(i.sequence), "different order"),
    ] :
    intent.tool === "amm_deposit" ? [
      must(tx.TransactionType === "AMMDeposit", "not an AMMDeposit"),
      must(tx.Account === i.account && samePool(), "different account or pool"),
      must(amountValue(tx.Amount) === Number(i.amount1) && amountValue(tx.Amount2) <= Number(i.amount2) * (1 + 1e-9), "different deposit amounts"),
    ] :
    intent.tool === "clawback_enable" ? [
      must(tx.TransactionType === "AccountSet" && tx.Account === i.account, "not an AccountSet by the issuer"),
      must(Number(tx.SetFlag) === 16 && tx.ClearFlag === undefined, "not exactly 'enable clawback'"),
      must(!tx.TransferRate && !tx.Domain && !tx.RegularKey, "changes more than the clawback flag"),
    ] :
    intent.tool === "clawback" ? [
      must(tx.TransactionType === "Clawback" && tx.Account === i.account, "not a Clawback by the issuer"),
      must(typeof tx.Amount === "object" && tx.Amount.issuer === i.holder && tx.Amount.currency === currencyCode(i.currency)
           && Number(tx.Amount.value) === Number(i.amount), "different holder, token or amount"),
    ] :
    intent.tool === "amm_withdraw" ? [
      must(tx.TransactionType === "AMMWithdraw", "not an AMMWithdraw"),
      must(tx.Account === i.account && samePool(), "different account or pool"),
      must(i.all ? (flags & 0x00020000) !== 0 : Number(tx.LPTokenIn?.value) === Number(i.lpTokens), "different LP amount"),
      must((flags & 0x00080000) === 0 && (flags & 0x00040000) === 0, "single-sided withdrawal not approved"),
    ] :
    intent.tool === "x402" ? [
      must(tx.TransactionType === "Payment", "not a Payment"),
      must(tx.Account === i.account && tx.Destination === i.payTo, "different sender or payee"),
      must(i.asset === "XRP" ? typeof (tx.DeliverMax ?? tx.Amount) === "string"
           : sameAsset(tx.DeliverMax ?? tx.Amount, { currency: currencyCode(i.asset.currency), issuer: i.asset.issuer } as any), "different asset"),
      must(amountValue(tx.DeliverMax ?? tx.Amount) <= Number(i.amount) * (1 + 1e-12), "more than the approved price"),
      must(!((Number(tx.Flags) || 0) & 0x00020000), "partial payment flag set"),
    ] :
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
