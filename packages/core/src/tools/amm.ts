// AMM pools: info, your LP position, two-asset deposit, proportional withdrawal. Withdrawals are proportional only —
// single-sided withdrawals pay the pool's fee on half the position and are easy to get wrong.
import { validate, AMMDepositFlags, AMMWithdrawFlags, dropsToXrp, type AMMDeposit, type AMMWithdraw, type Amount } from "xrpl";
import type { Ledger } from "../ledger.js";
import { assertAddress, getBalances } from "./account.js";
import type { Prepared } from "./escrow.js";
import { toAmount, toCurrency, amountValue, assetLabel, sameAsset, type Asset } from "../amounts.js";

export interface AmmPool {
  account: string;
  asset1: Asset; asset2: Asset;
  amount1: number; amount2: number;
  lpToken: { currency: string; issuer: string; value: string };
  tradingFeePct: number;
  spotPrice: number;                 // asset2 per 1 asset1
  reserve(a: Asset): number;
}

export async function getAmm(ledger: Ledger, asset1: Asset, asset2: Asset): Promise<AmmPool> {
  let r: any;
  try {
    r = (await ledger.request<any>({ command: "amm_info", asset: toCurrency(asset1), asset2: toCurrency(asset2), ledger_index: "validated" })).amm;
  } catch (e: any) {
    if (String(e?.data?.error ?? e?.message).includes("actNotFound")) throw new Error(`no AMM pool for ${assetLabel(asset1)}/${assetLabel(asset2)}`);
    throw e;
  }
  // amm_info may return the pair in either order
  const firstIs1 = sameAsset(r.amount, asset1);
  const a1 = amountValue(firstIs1 ? r.amount : r.amount2), a2 = amountValue(firstIs1 ? r.amount2 : r.amount);
  return {
    account: r.account, asset1, asset2, amount1: a1, amount2: a2, lpToken: r.lp_token,
    tradingFeePct: Number(r.trading_fee) / 1000, spotPrice: a2 / a1,
    reserve: (a: Asset) => (sameAsset(toCurrency(a) as any, asset1) ? a1 : a2),
  };
}

export interface AmmPosition { lpTokens: number; sharePct: number; worth1: number; worth2: number }

export async function getAmmPosition(ledger: Ledger, account: string, pool: AmmPool): Promise<AmmPosition> {
  const b = await getBalances(ledger, account);
  const lp = Number(b.tokens.find((t) => t.issuer === pool.account)?.balance ?? 0);
  const share = lp / Number(pool.lpToken.value);
  return { lpTokens: lp, sharePct: share * 100, worth1: pool.amount1 * share, worth2: pool.amount2 * share };
}

const fmt = (n: number) => Number(n.toPrecision(12)).toString();

export interface AmmDepositInput { account: string; asset1: Asset; asset2: Asset; amount1: string }

/** Two-asset deposit at the pool's current ratio (amount2 is computed, with 0.5 % headroom for price moves). */
export async function prepareAmmDeposit(ledger: Ledger, input: AmmDepositInput): Promise<Prepared<AMMDeposit> & { amount2: string }> {
  assertAddress(input.account, "account");
  const pool = await getAmm(ledger, input.asset1, input.asset2);
  const a1 = Number(input.amount1);
  if (!(a1 > 0)) throw new Error("amount must be positive");
  const a2 = a1 * pool.spotPrice * 1.005;
  const amount2 = input.asset2 === "XRP" ? (Math.ceil(a2 * 1e6) / 1e6).toString() : fmt(a2);
  const tx: AMMDeposit = { TransactionType: "AMMDeposit", Account: input.account,
    Asset: toCurrency(input.asset1) as any, Asset2: toCurrency(input.asset2) as any,
    Amount: toAmount(input.asset1, input.amount1), Amount2: toAmount(input.asset2, amount2), Flags: AMMDepositFlags.tfTwoAsset };
  const c = await ledger.client();
  const filled = (await c.autofill(tx)) as AMMDeposit;
  validate(filled as any);
  const L1 = assetLabel(input.asset1), L2 = assetLabel(input.asset2);
  return { network: ledger.network, tx: filled, amount2, warnings: ["the pool takes both assets at its current ratio; any unused headroom stays with you"],
    summary: `Add liquidity to ${L1}/${L2}: ${input.amount1} ${L1} + up to ${amount2} ${L2}`,
    details: { pool: `${L1}/${L2} (fee ${pool.tradingFeePct}%)`, deposit: `${input.amount1} ${L1}`, upTo: `${amount2} ${L2}`,
               poolPrice: `${fmt(pool.spotPrice)} ${L2} per ${L1}`, fee: `${dropsToXrp(filled.Fee!)} XRP` } };
}

export interface AmmWithdrawInput { account: string; asset1: Asset; asset2: Asset; lpTokens?: string; all?: boolean }

/** Proportional withdrawal: get both assets back for the LP tokens returned (or all of them). */
export async function prepareAmmWithdraw(ledger: Ledger, input: AmmWithdrawInput): Promise<Prepared<AMMWithdraw>> {
  assertAddress(input.account, "account");
  const pool = await getAmm(ledger, input.asset1, input.asset2);
  const pos = await getAmmPosition(ledger, input.account, pool);
  if (!(pos.lpTokens > 0)) throw new Error("you have no LP tokens in this pool");
  const lp = input.all ? pos.lpTokens : Number(input.lpTokens);
  if (!(lp > 0) || lp > pos.lpTokens * (1 + 1e-12)) throw new Error(`you hold ${pos.lpTokens} LP tokens`);
  const share = lp / Number(pool.lpToken.value);
  const tx: AMMWithdraw = { TransactionType: "AMMWithdraw", Account: input.account,
    Asset: toCurrency(input.asset1) as any, Asset2: toCurrency(input.asset2) as any,
    ...(input.all ? { Flags: AMMWithdrawFlags.tfWithdrawAll }
                  : { LPTokenIn: { currency: pool.lpToken.currency, issuer: pool.lpToken.issuer, value: fmt(lp) }, Flags: AMMWithdrawFlags.tfLPToken }) };
  const c = await ledger.client();
  const filled = (await c.autofill(tx)) as AMMWithdraw;
  validate(filled as any);
  const L1 = assetLabel(input.asset1), L2 = assetLabel(input.asset2);
  return { network: ledger.network, tx: filled, warnings: [],
    summary: `Withdraw ${input.all ? "all" : fmt(lp)} LP from ${L1}/${L2}: ≈ ${fmt(pool.amount1 * share)} ${L1} + ${fmt(pool.amount2 * share)} ${L2}`,
    details: { pool: `${L1}/${L2}`, lpTokens: fmt(lp), receive: `≈ ${fmt(pool.amount1 * share)} ${L1} + ${fmt(pool.amount2 * share)} ${L2}`,
               method: "proportional (both assets, no single-sided fee)", fee: `${dropsToXrp(filled.Fee!)} XRP` } };
}

export type { Amount };
