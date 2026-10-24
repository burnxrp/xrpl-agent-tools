// Amount helpers shared by payments, DEX and AMM tools.
import { xrpToDrops, dropsToXrp, convertHexToString, type Amount, type Currency } from "xrpl";
import { currencyCode, type Asset } from "./tools/payment.js";

export type { Asset };

export function toAmount(asset: Asset, value: string | number): Amount {
  const v = typeof value === "number" ? Number(value.toPrecision(15)).toString() : value;
  if (asset === "XRP") return xrpToDrops(Number(Number(v).toFixed(6)).toString());
  return { currency: currencyCode(asset.currency), issuer: asset.issuer, value: v };
}

export function toCurrency(asset: Asset): Currency {
  return asset === "XRP" ? { currency: "XRP" } : { currency: currencyCode(asset.currency), issuer: asset.issuer };
}

export function amountValue(a: Amount): number {
  return typeof a === "string" ? Number(dropsToXrp(a)) : Number(a.value);
}

export function displayCurrency(code: string): string {
  if (code.length !== 40) return code;
  if (code.startsWith("03")) return "LP";                       // AMM LP tokens use a binary code, not text
  const t = convertHexToString(code).replace(/\0+$/, "");
  return t && /^[\x20-\x7E]+$/.test(t) ? t : code.slice(0, 8) + "…";
}

export function assetLabel(a: Asset): string {
  return a === "XRP" ? "XRP" : displayCurrency(currencyCode(a.currency));
}

export function sameAsset(amount: Amount | Currency | undefined, asset: Asset): boolean {
  if (!amount) return false;
  const a: any = amount;   // xrpl.js 5 types also cover MPTs, which have no "currency"
  if (asset === "XRP") return typeof a === "string" || a.currency === "XRP";
  return typeof a === "object" && a.currency === currencyCode(asset.currency) && a.issuer === asset.issuer;
}
