// Native payments: XRP and issued tokens (same-currency, direct). Never partial (tfPartialPayment) — the recipient
// gets exactly the amount or nothing. Issuer transfer fees are computed into SendMax and shown to the human.
import { validate, xrpToDrops, dropsToXrp, convertStringToHex, type Payment, type IssuedCurrencyAmount } from "xrpl";
import type { Ledger } from "../ledger.js";
import { assertAddress, getAccount } from "./account.js";
import type { Prepared } from "./escrow.js";

export type Asset = "XRP" | { currency: string; issuer: string };

export interface PaymentInput {
  account: string;
  destination: string;
  amount: string;            // decimal string
  asset: Asset;
  destinationTag?: number;
  memo?: string;
}

/** "USD" stays "USD"; longer codes become the 40-char hex form XRPL uses. */
export function currencyCode(c: string): string {
  if (/^[A-Fa-f0-9]{40}$/.test(c)) return c.toUpperCase();
  if (c.length === 3 && c !== "XRP") return c;
  if (c.length < 3 || c.length > 20) throw new Error(`currency "${c}" must be 3–20 characters`);
  return convertStringToHex(c).padEnd(40, "0").toUpperCase();
}

const PARTIAL = 0x00020000;

async function lineBetween(ledger: Ledger, holder: string, issuer: string, code: string) {
  const r = await ledger.request<any>({ command: "account_lines", account: holder, peer: issuer, ledger_index: "validated" });
  return (r.lines ?? []).find((l: any) => l.currency === code) as any | undefined;
}

async function transferRate(ledger: Ledger, issuer: string): Promise<number> {
  const r = await ledger.request<any>({ command: "account_info", account: issuer, ledger_index: "validated" });
  const tr = Number(r.account_data.TransferRate || 0);
  return tr > 1_000_000_000 ? tr / 1_000_000_000 : 1;   // 1.01 = 1 % fee
}

const fmt = (n: number) => Number(n.toPrecision(15)).toString();

export async function preparePayment(ledger: Ledger, input: PaymentInput): Promise<Prepared<Payment>> {
  assertAddress(input.account, "account");
  assertAddress(input.destination, "destination");
  if (input.account === input.destination) throw new Error("sender and destination are the same account");
  const value = Number(input.amount);
  if (!(value > 0) || !/^\d+(\.\d+)?$/.test(input.amount)) throw new Error("amount must be a positive decimal number");
  const warnings: string[] = [];
  const [src, dst] = await Promise.all([getAccount(ledger, input.account), getAccount(ledger, input.destination)]);
  if (!src.exists) throw new Error(`account ${input.account} is not activated on ${ledger.network}`);
  if (dst.exists && dst.flags.requireDestTag && input.destinationTag === undefined) throw new Error("destination requires a destination tag");
  if (dst.flags.depositAuth) warnings.push("destination has Deposit Authorization on — it must have pre-authorized you or the payment fails");

  let amount: string | IssuedCurrencyAmount;
  let sendMax: IssuedCurrencyAmount | undefined;
  const details: Record<string, string> = { from: input.account, to: input.destination };

  if (input.asset === "XRP") {
    if (input.amount.includes(".") && input.amount.split(".")[1].length > 6) throw new Error("XRP has at most 6 decimals");
    if (!dst.exists) {
      const base = Number((await ledger.request<any>({ command: "server_info" })).info.validated_ledger.reserve_base_xrp);
      if (value < base) throw new Error(`destination is not activated — sending at least ${base} XRP activates it`);
      warnings.push(`destination is new: this payment activates it (${base} XRP of it becomes its reserve)`);
    }
    if (Number(src.spendableXrp) < value) throw new Error(`only ${src.spendableXrp} XRP spendable (reserve ${src.reserveXrp} is locked)`);
    amount = xrpToDrops(input.amount);
    details.amount = `${input.amount} XRP`;
  } else {
    const { issuer } = input.asset;
    assertAddress(issuer, "issuer");
    const code = currencyCode(input.asset.currency);
    if (!dst.exists) throw new Error("destination is not activated — it can't hold tokens yet");
    amount = { currency: code, issuer, value: input.amount };
    details.amount = `${input.amount} ${input.asset.currency}`;
    details.issuer = issuer;
    if (input.destination !== issuer) {
      const dl = await lineBetween(ledger, input.destination, issuer, code);
      if (!dl) throw new Error(`destination has no trustline for ${input.asset.currency} from this issuer — they must add one first`);
      if (Number(dl.limit) - Number(dl.balance) < value) throw new Error("destination's trustline limit is too low for this amount");
      if (dl.freeze || dl.freeze_peer) throw new Error("this trustline is frozen");
    }
    if (input.account !== issuer) {
      const sl = await lineBetween(ledger, input.account, issuer, code);
      if (!sl || Number(sl.balance) < value) throw new Error(`you hold ${sl ? sl.balance : 0} ${input.asset.currency} — not enough`);
      if (input.destination !== issuer) {
        const rate = await transferRate(ledger, issuer);
        if (rate > 1) {
          const max = value * rate;
          if (Number(sl.balance) < max) throw new Error(`with the issuer's ${fmt((rate - 1) * 100)}% transfer fee you need ${fmt(max)} — you hold ${sl.balance}`);
          sendMax = { currency: code, issuer, value: fmt(max) };
          details.transferFee = `${fmt((rate - 1) * 100)}% (issuer fee) — you pay up to ${fmt(max)} ${input.asset.currency}`;
          warnings.push(`issuer charges a ${fmt((rate - 1) * 100)}% transfer fee`);
        }
      }
    }
  }

  const tx: Payment = {
    TransactionType: "Payment", Account: input.account, Destination: input.destination, Amount: amount,
    ...(sendMax ? { SendMax: sendMax } : {}),
    ...(input.destinationTag !== undefined ? { DestinationTag: input.destinationTag } : {}),
    ...(input.memo ? { Memos: [{ Memo: { MemoData: convertStringToHex(input.memo) } }] } : {}),
  };
  const c = await ledger.client();
  const filled = (await c.autofill(tx)) as Payment;
  if ((Number(filled.Flags) || 0) & PARTIAL) throw new Error("refusing a partial payment");
  validate(filled as any);
  details.fee = `${dropsToXrp(filled.Fee!)} XRP`;
  if (input.destinationTag !== undefined) details.destinationTag = String(input.destinationTag);
  return { network: ledger.network, tx: filled, warnings, details,
           summary: `Send ${details.amount} to ${input.destination}` };
}
