// Shared by every approval surface (the console in a browser, the Xaman phone bridge in the adapter): rebuild the
// exact transaction for an approved intent, and check that what a wallet signed is what was reviewed.
import { decode } from "xrpl";
import type { Ledger } from "./ledger.js";
import type { Intent } from "./intent.js";
import type { Prepared } from "./tools/escrow.js";
import { prepareEscrowCreate, prepareEscrowFinish, prepareEscrowCancel } from "./tools/escrow.js";
import { preparePayment } from "./tools/payment.js";
import { prepareSwap, prepareLimitOrder, prepareOfferCancel } from "./tools/dex.js";
import { prepareAmmDeposit, prepareAmmWithdraw } from "./tools/amm.js";
import { prepareEnableClawback, prepareClawback } from "./tools/clawback.js";

/** Re-prepare fresh from an approved intent (transactions expire within ~a minute; intents don't). Not for "x402"
 *  (that needs a fresh quote from the seller first). */
export async function prepareFromIntent(ledger: Ledger, intent: Intent): Promise<Prepared<any>> {
  const i: any = intent.input;
  switch (intent.tool) {
    case "payment": return preparePayment(ledger, i);
    case "escrow_create": return prepareEscrowCreate(ledger, { account: i.account, destination: i.destination, amount: i.amount,
      finishAfter: i.finishAfter, cancelAfter: i.cancelAfter, destinationTag: i.destinationTag, memo: i.memo });
    case "escrow_finish": return prepareEscrowFinish(ledger, i);
    case "escrow_cancel": return prepareEscrowCancel(ledger, i);
    case "swap": return prepareSwap(ledger, i);                     // keeps the agent's approved minimum
    case "limit_order": return prepareLimitOrder(ledger, i);
    case "offer_cancel": return prepareOfferCancel(ledger, i);
    case "amm_withdraw": return prepareAmmWithdraw(ledger, i);
    case "clawback_enable": return prepareEnableClawback(ledger, i);
    case "clawback": return prepareClawback(ledger, i);
    case "amm_deposit": {
      const d = await prepareAmmDeposit(ledger, i);
      if (Number(d.amount2) > Number(i.amount2) * (1 + 1e-9))
        throw new Error(`The pool moved: this deposit now needs ${d.amount2} (approved ${i.amount2}). Ask the agent to request it again.`);
      return d;
    }
    default: throw new Error(`${intent.tool} can't be re-prepared directly`);
  }
}

/** Why a wallet's signed blob differs from the transaction the human reviewed (undefined = it's the same). Wallets may
 *  only fill in fee, sequence, expiry and the signature, add the fully-canonical flag, and keep the fee sane. */
export function signedBlobProblem(prepared: Record<string, any>, txBlob: string): string | undefined {
  let signed: Record<string, any>;
  try { signed = decode(txBlob) as Record<string, any>; } catch { return "the wallet returned an unreadable transaction"; }
  const ignore = new Set(["Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "TxnSignature", "Flags", "NetworkID"]);
  for (const k of new Set([...Object.keys(prepared), ...Object.keys(signed)])) {
    if (ignore.has(k)) continue;
    if (JSON.stringify(signed[k]) !== JSON.stringify(prepared[k])) return `the wallet changed "${k}"`;
  }
  const FULLY_CANONICAL = 0x80000000;
  if (((Number(signed.Flags) || 0) & ~FULLY_CANONICAL) >>> 0 !== ((Number(prepared.Flags) || 0) & ~FULLY_CANONICAL) >>> 0)
    return "the wallet changed the transaction flags";
  if (Number(signed.Fee) > Math.max(Number(prepared.Fee) * 10, 2000)) return `the wallet set a fee of ${signed.Fee} drops`;
  if (signed.Account !== prepared.Account) return "signed by a different account";
  return undefined;
}
