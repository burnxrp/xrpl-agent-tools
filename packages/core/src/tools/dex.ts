// DEX: order books, swaps (Fill-or-Kill OfferCreate — fills completely at ≥ the minimum, or nothing happens and no
// offer is left resting), resting limit orders, and cancelling them. The ledger routes through the order book AND
// any AMM pool automatically; the quote here estimates both and the minimum protects the user either way.
import { validate, OfferCreateFlags, dropsToXrp, type OfferCreate, type OfferCancel, type BookOffer } from "xrpl";
import type { Ledger } from "../ledger.js";
import { assertAddress, getAccount, getBalances } from "./account.js";
import type { Prepared } from "./escrow.js";
import { toAmount, toCurrency, amountValue, assetLabel, displayCurrency, type Asset } from "../amounts.js";
import { getAmm } from "./amm.js";
import { currencyCode } from "./payment.js";

export interface BookSide { price: number; amount: number; total: number }   // price = quote per 1 base
export interface OrderBook { base: string; quote: string; bids: BookSide[]; asks: BookSide[]; bestBid?: number; bestAsk?: number; mid?: number }

async function offers(ledger: Ledger, takerGets: Asset, takerPays: Asset, limit: number): Promise<BookOffer[]> {
  const r = await ledger.request<any>({ command: "book_offers", taker_gets: toCurrency(takerGets), taker_pays: toCurrency(takerPays),
                                        ledger_index: "validated", limit });
  return r.offers ?? [];
}

/** Order book for base/quote (prices in quote per 1 base). */
export async function getOrderBook(ledger: Ledger, base: Asset, quote: Asset, limit = 10): Promise<OrderBook> {
  const [askOffers, bidOffers] = await Promise.all([offers(ledger, base, quote, limit), offers(ledger, quote, base, limit)]);
  const g = (o: any) => amountValue(o.taker_gets_funded ?? o.TakerGets), p = (o: any) => amountValue(o.taker_pays_funded ?? o.TakerPays);
  let t = 0;
  const asks = askOffers.map((o) => { const amt = g(o), price = p(o) / amt; t += amt; return { price, amount: amt, total: t }; }).filter((x) => x.amount > 0);
  t = 0;
  const bids = bidOffers.map((o) => { const amt = p(o), price = g(o) / amt; t += amt; return { price, amount: amt, total: t }; }).filter((x) => x.amount > 0);
  const bestAsk = asks[0]?.price, bestBid = bids[0]?.price;
  return { base: assetLabel(base), quote: assetLabel(quote), asks, bids, bestAsk, bestBid,
           mid: bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk ?? bestBid };
}

export interface SwapQuote { sell: string; expectedOut: number; via: string; ammOut: number; bookOut: number; priceImpactPct?: number }

/** Estimate what selling `amount` of `sell` returns in `buy`, from the AMM pool and the order book. */
export async function quoteSwap(ledger: Ledger, sell: Asset, buy: Asset, amount: string): Promise<SwapQuote> {
  const x = Number(amount);
  let ammOut = 0, impact: number | undefined;
  const amm = await getAmm(ledger, sell, buy).catch(() => null);
  if (amm) {
    const rin = amm.reserve(sell), rout = amm.reserve(buy);
    const inAfterFee = x * (1 - amm.tradingFeePct / 100);
    ammOut = (rout * inAfterFee) / (rin + inAfterFee);
    impact = (1 - (ammOut / x) / (rout / rin)) * 100;
  }
  // walk the book: offers that GIVE `buy` and TAKE `sell`
  let left = x, bookOut = 0;
  for (const o of await offers(ledger, buy, sell, 50)) {
    const gets = amountValue((o as any).taker_gets_funded ?? o.TakerGets), pays = amountValue((o as any).taker_pays_funded ?? o.TakerPays);
    if (!(gets > 0 && pays > 0)) continue;
    const use = Math.min(left, pays);
    bookOut += gets * (use / pays);
    left -= use;
    if (left <= 1e-12) break;
  }
  if (left > 1e-12) bookOut = left < x ? bookOut : 0;   // book alone can't fill → don't count a partial book quote
  const expectedOut = Math.max(ammOut, bookOut);
  if (!(expectedOut > 0)) throw new Error(`no market for ${assetLabel(sell)} → ${assetLabel(buy)} (no AMM pool and no order book liquidity)`);
  return { sell: `${amount} ${assetLabel(sell)}`, expectedOut, ammOut, bookOut, priceImpactPct: impact,
           via: ammOut >= bookOut ? "AMM pool" : "order book" };
}

export interface SwapInput { account: string; sell: Asset; amount: string; buy: Asset; slippagePct?: number; minOut?: string }

/** Swap: sell exactly `amount`, receive at least the minimum — or nothing happens (Fill-or-Kill). */
export async function prepareSwap(ledger: Ledger, input: SwapInput): Promise<Prepared<OfferCreate> & { quote: SwapQuote; minOut: string }> {
  assertAddress(input.account, "account");
  const x = Number(input.amount);
  if (!(x > 0)) throw new Error("amount must be positive");
  const slip = input.slippagePct ?? 1;
  if (!(slip >= 0 && slip <= 20)) throw new Error("slippage must be between 0 and 20 %");
  const q = await quoteSwap(ledger, input.sell, input.buy, input.amount);
  const minOut = input.minOut ?? Number((q.expectedOut * (1 - slip / 100)).toPrecision(15)).toString();
  const warnings: string[] = [];
  const bals = await getBalances(ledger, input.account);
  if (input.sell === "XRP") {
    if (Number(bals.xrp.spendableXrp) < x) throw new Error(`only ${bals.xrp.spendableXrp} XRP spendable`);
  } else {
    const t = bals.tokens.find((b) => b.issuer === (input.sell as any).issuer && (b.currency === assetLabel(input.sell)));
    if (!t || Number(t.balance) < x) throw new Error(`you hold ${t?.balance ?? 0} ${assetLabel(input.sell)}`);
  }
  if (input.buy !== "XRP" && !bals.tokens.some((b) => b.issuer === (input.buy as any).issuer && b.currency === assetLabel(input.buy)))
    warnings.push(`you have no trustline for ${assetLabel(input.buy)} yet — the trade creates one (locks ${"0.2"} XRP owner reserve)`);
  if (q.priceImpactPct !== undefined && q.priceImpactPct > 3) warnings.push(`large trade: about ${q.priceImpactPct.toFixed(1)}% price impact on the pool`);
  const tx: OfferCreate = { TransactionType: "OfferCreate", Account: input.account,
    TakerGets: toAmount(input.sell, input.amount), TakerPays: toAmount(input.buy, minOut),
    Flags: OfferCreateFlags.tfFillOrKill | OfferCreateFlags.tfSell };
  const c = await ledger.client();
  const filled = (await c.autofill(tx)) as OfferCreate;
  validate(filled as any);
  return { network: ledger.network, tx: filled, quote: q, minOut, warnings,
    summary: `Swap ${input.amount} ${assetLabel(input.sell)} for at least ${minOut} ${assetLabel(input.buy)} (≈${Number(q.expectedOut.toPrecision(8))} expected)`,
    details: { sell: `${input.amount} ${assetLabel(input.sell)}`, receiveAtLeast: `${minOut} ${assetLabel(input.buy)}`,
               expected: `${Number(q.expectedOut.toPrecision(8))} ${assetLabel(input.buy)} via ${q.via}`, slippage: `${slip}%`,
               fillRule: "fills completely or not at all", fee: `${dropsToXrp(filled.Fee!)} XRP` } };
}

export interface LimitOrderInput { account: string; sell: Asset; sellAmount: string; buy: Asset; buyAmount: string; passive?: boolean; expiresIn?: number }

/** Resting limit order (stays on the book until filled, cancelled or expired). */
export async function prepareLimitOrder(ledger: Ledger, input: LimitOrderInput): Promise<Prepared<OfferCreate>> {
  assertAddress(input.account, "account");
  if (!(Number(input.sellAmount) > 0 && Number(input.buyAmount) > 0)) throw new Error("amounts must be positive");
  const acct = await getAccount(ledger, input.account);
  if (!acct.exists) throw new Error("account not activated");
  const tx: OfferCreate = { TransactionType: "OfferCreate", Account: input.account,
    TakerGets: toAmount(input.sell, input.sellAmount), TakerPays: toAmount(input.buy, input.buyAmount),
    ...(input.passive ? { Flags: OfferCreateFlags.tfPassive } : {}),
    ...(input.expiresIn ? { Expiration: Math.floor(Date.now() / 1000) - 946684800 + input.expiresIn } : {}) };
  const c = await ledger.client();
  const filled = (await c.autofill(tx)) as OfferCreate;
  validate(filled as any);
  const price = Number(input.buyAmount) / Number(input.sellAmount);
  return { network: ledger.network, tx: filled, warnings: ["this order rests on the book and locks an owner reserve until it fills or you cancel it"],
    summary: `Limit order: sell ${input.sellAmount} ${assetLabel(input.sell)} for ${input.buyAmount} ${assetLabel(input.buy)} (${Number(price.toPrecision(8))} ${assetLabel(input.buy)} each)`,
    details: { sell: `${input.sellAmount} ${assetLabel(input.sell)}`, for: `${input.buyAmount} ${assetLabel(input.buy)}`,
               price: `${Number(price.toPrecision(8))} ${assetLabel(input.buy)} per ${assetLabel(input.sell)}`,
               fee: `${dropsToXrp(filled.Fee!)} XRP`, sequence: String(filled.Sequence) } };
}

export interface OpenOffer { sequence: number; sells: string; wants: string; price: number }

export async function listOffers(ledger: Ledger, account: string): Promise<OpenOffer[]> {
  assertAddress(account);
  const r = await ledger.request<any>({ command: "account_offers", account, ledger_index: "validated", limit: 200 });
  const lab = (a: any) => typeof a === "string" ? `${dropsToXrp(a)} XRP` : `${a.value} ${displayCurrency(a.currency)}`;
  return (r.offers ?? []).map((o: any) => ({ sequence: o.seq, sells: lab(o.taker_gets), wants: lab(o.taker_pays),
    price: amountValue(o.taker_pays) / amountValue(o.taker_gets) }));
}

export async function prepareOfferCancel(ledger: Ledger, input: { account: string; sequence: number }): Promise<Prepared<OfferCancel>> {
  const open = await listOffers(ledger, input.account);
  const o = open.find((x) => x.sequence === input.sequence);
  if (!o) throw new Error(`no open offer #${input.sequence} for this account`);
  const tx: OfferCancel = { TransactionType: "OfferCancel", Account: input.account, OfferSequence: input.sequence };
  const c = await ledger.client();
  const filled = (await c.autofill(tx)) as OfferCancel;
  validate(filled as any);
  return { network: ledger.network, tx: filled, warnings: [], summary: `Cancel order #${input.sequence} (sells ${o.sells} for ${o.wants})`,
           details: { order: `#${input.sequence}`, sells: o.sells, wants: o.wants, fee: `${dropsToXrp(filled.Fee!)} XRP` } };
}

export { currencyCode };
