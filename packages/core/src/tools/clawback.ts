// Issuer clawback (XLS-39): an issuer that enabled AllowTrustLineClawback can take back issued tokens from a holder.
// Enabling is permanent and only possible while the issuer owns nothing on the ledger (no trustlines, offers, escrows…),
// so it must be decided before the token is issued. Holders can see the flag on the issuer's account before trusting it.
import { validate, type AccountSet, type Clawback } from "xrpl";
import type { Ledger } from "../ledger.js";
import { assertAddress } from "./account.js";
import { currencyCode } from "./payment.js";
import { displayCurrency } from "../amounts.js";
import type { Prepared } from "./escrow.js";

const LSF_ALLOW_CLAWBACK = 0x80000000, LSF_NO_FREEZE = 0x00200000, ASF_ALLOW_CLAWBACK = 16;

export interface ClawbackStatus {
  issuer: string; enabled: boolean; canEnable: boolean; ownerCount: number; noFreeze: boolean; why?: string;
}

export async function getClawbackStatus(ledger: Ledger, issuer: string): Promise<ClawbackStatus> {
  assertAddress(issuer);
  const r = await ledger.request<any>({ command: "account_info", account: issuer, ledger_index: "validated" });
  const flags = Number(r.account_data.Flags) >>> 0, ownerCount = Number(r.account_data.OwnerCount || 0);
  const enabled = (flags & LSF_ALLOW_CLAWBACK) !== 0, noFreeze = (flags & LSF_NO_FREEZE) !== 0;
  const why = enabled ? undefined
    : noFreeze ? "the account has NoFreeze set, which can't be combined with clawback"
    : ownerCount > 0 ? `the account already owns ${ownerCount} ledger object(s) (trustlines, offers…); clawback can only be enabled on an empty issuer`
    : undefined;
  return { issuer, enabled, canEnable: !enabled && !why, ownerCount, noFreeze, why };
}

export interface Holder { holder: string; currency: string; code: string; balance: number; frozen: boolean }

/** Who holds this issuer's tokens (from the issuer's trustlines). */
export async function listHolders(ledger: Ledger, issuer: string, currency?: string): Promise<Holder[]> {
  assertAddress(issuer);
  const out: Holder[] = [];
  let marker: unknown;
  do {
    const r = await ledger.request<any>({ command: "account_lines", account: issuer, ledger_index: "validated", limit: 400, ...(marker ? { marker } : {}) });
    for (const l of r.lines ?? []) {
      const bal = -Number(l.balance);                       // the issuer sees holders' balances as negative
      if (bal <= 0) continue;
      if (currency && l.currency !== currencyCode(currency)) continue;
      out.push({ holder: l.account, currency: displayCurrency(l.currency), code: l.currency, balance: bal, frozen: !!l.freeze });
    }
    marker = r.marker;
  } while (marker && out.length < 2000);
  return out.sort((a, b) => b.balance - a.balance);
}

async function finalize<T extends Record<string, any>>(ledger: Ledger, tx: T): Promise<T> {
  const c = await ledger.client();
  const filled = (await c.autofill(tx as any)) as unknown as T;
  validate(filled as any);
  return filled;
}

/** Permanently allow this issuer to claw back. Refused unless the ledger would accept it. */
export async function prepareEnableClawback(ledger: Ledger, input: { account: string }): Promise<Prepared<AccountSet>> {
  const s = await getClawbackStatus(ledger, input.account);
  if (s.enabled) throw new Error("clawback is already enabled for this issuer");
  if (!s.canEnable) throw new Error(`clawback can't be enabled: ${s.why}`);
  const tx = await finalize<AccountSet>(ledger, { TransactionType: "AccountSet", Account: input.account, SetFlag: ASF_ALLOW_CLAWBACK });
  return { network: ledger.network, tx, summary: `Permanently enable token clawback for issuer ${input.account}`,
    details: { issuer: input.account, flag: "AllowTrustLineClawback", reversible: "NO — it can never be turned off" },
    warnings: ["This is permanent. Holders will see that you can take tokens back from them, which some won't accept.",
               "It must be done before you issue tokens: it's only possible while the account owns nothing on the ledger."] };
}

export interface ClawbackInput { account: string; holder: string; currency: string; amount: string }

/** Claw back `amount` of the issuer's token from one holder. Exact: refused if the holder has less. */
export async function prepareClawback(ledger: Ledger, input: ClawbackInput): Promise<Prepared<Clawback>> {
  assertAddress(input.holder);
  if (input.holder === input.account) throw new Error("an issuer can't claw back from itself");
  if (!(Number(input.amount) > 0)) throw new Error("amount must be positive");
  const s = await getClawbackStatus(ledger, input.account);
  if (!s.enabled) throw new Error("clawback is not enabled for this issuer — it must be enabled before the token is issued");
  const code = currencyCode(input.currency);
  const line = (await listHolders(ledger, input.account)).find((h) => h.holder === input.holder && h.code === code);
  if (!line) throw new Error(`${input.holder} holds no ${input.currency} from this issuer`);
  if (Number(input.amount) > line.balance) throw new Error(`${input.holder} only holds ${line.balance} ${input.currency}`);
  // In a Clawback the Amount's "issuer" field names the HOLDER being clawed from.
  const tx = await finalize<Clawback>(ledger, { TransactionType: "Clawback", Account: input.account,
    Amount: { currency: code, issuer: input.holder, value: input.amount } });
  return { network: ledger.network, tx, summary: `Claw back ${input.amount} ${input.currency} from ${input.holder}`,
    details: { issuer: input.account, holder: input.holder, amount: `${input.amount} ${input.currency}`,
               holderBalance: `${line.balance} → ${Number((line.balance - Number(input.amount)).toPrecision(15))}` },
    warnings: Number(input.amount) === line.balance ? ["This takes the holder's entire balance."] : [] };
}
