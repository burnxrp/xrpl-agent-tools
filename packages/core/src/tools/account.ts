// Account & balances — read straight from validated ledger data.
import { dropsToXrp, isValidClassicAddress, convertHexToString } from "xrpl";
import type { Ledger } from "../ledger.js";

export interface AccountInfo {
  address: string;
  exists: boolean;
  balanceXrp: string;
  reserveXrp: string;      // locked by the ledger (base + owner reserve)
  spendableXrp: string;
  ownerCount: number;
  flags: { disableMaster: boolean; requireDestTag: boolean; depositAuth: boolean; defaultRipple: boolean };
}

export function assertAddress(a: string, label = "address"): void {
  if (!isValidClassicAddress(a)) throw new Error(`${label} "${a}" is not a valid XRPL classic address`);
}

async function reserves(ledger: Ledger): Promise<{ base: number; inc: number }> {
  const r = await ledger.request<any>({ command: "server_info" });
  const v = r.info.validated_ledger;
  return { base: Number(v.reserve_base_xrp), inc: Number(v.reserve_inc_xrp) };
}

export async function getAccount(ledger: Ledger, address: string): Promise<AccountInfo> {
  assertAddress(address);
  const empty = { address, exists: false, balanceXrp: "0", reserveXrp: "0", spendableXrp: "0", ownerCount: 0,
                  flags: { disableMaster: false, requireDestTag: false, depositAuth: false, defaultRipple: false } };
  let data: any;
  try {
    data = (await ledger.request<any>({ command: "account_info", account: address, ledger_index: "validated" })).account_data;
  } catch (e: any) {
    if (String(e?.data?.error ?? e?.message).includes("actNotFound")) return empty;
    throw e;
  }
  const { base, inc } = await reserves(ledger);
  const bal = Number(dropsToXrp(data.Balance));
  const reserve = base + inc * Number(data.OwnerCount);
  const f = Number(data.Flags);
  return {
    address, exists: true, balanceXrp: String(bal), reserveXrp: String(reserve),
    spendableXrp: String(Math.max(0, +(bal - reserve).toFixed(6))), ownerCount: Number(data.OwnerCount),
    flags: { disableMaster: !!(f & 0x00100000), requireDestTag: !!(f & 0x00020000),
             depositAuth: !!(f & 0x01000000), defaultRipple: !!(f & 0x00800000) },
  };
}

export interface TokenBalance { currency: string; issuer: string; balance: string; limit: string }

export async function getBalances(ledger: Ledger, address: string): Promise<{ xrp: AccountInfo; tokens: TokenBalance[] }> {
  const xrp = await getAccount(ledger, address);
  if (!xrp.exists) return { xrp, tokens: [] };
  const r = await ledger.request<any>({ command: "account_lines", account: address, ledger_index: "validated", limit: 400 });
  const tokens = (r.lines ?? []).map((l: any) => ({
    currency: l.currency.length === 40 ? convertHexToString(l.currency).replace(/\0+$/, "") || l.currency : l.currency,
    issuer: l.account, balance: l.balance, limit: l.limit,
  }));
  return { xrp, tokens };
}
