// DEX & AMM end to end on public Testnet: a real token, a real AMM pool, a real order book.
import { Wallet } from "xrpl";
import { Ledger, currencyCode, getAmm, getAmmPosition, getOrderBook, quoteSwap, prepareSwap, prepareLimitOrder, listOffers,
         prepareOfferCancel, prepareAmmDeposit, prepareAmmWithdraw, submitSigned, signLocally, matchesIntent, type Intent } from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };

async function main() {
  const ledger = new Ledger({ network: "testnet" });
  const c = await ledger.client();
  console.log(`network: ${ledger.network} via ${ledger.endpoint}`);
  const w = await Promise.all([1, 2, 3, 4].map(async () => (await c.fundWallet()).wallet));
  const [issuer, lp, alice, maker] = w;
  const raw = async (wa: Wallet, tx: any) => submitSigned(ledger, signLocally(wa.seed!, await c.autofill(tx)).txBlob);
  const run = async (wa: Wallet, p: { tx: any }) => submitSigned(ledger, signLocally(wa.seed!, p.tx).txBlob);
  const onLedger = async (h: string) => (await ledger.request<any>({ command: "tx", transaction: h })).tx_json;
  const AGT = { currency: "AGT", issuer: issuer.classicAddress };

  console.log("setup: token AGT, balances, AMM pool 50 XRP / 500 AGT (0.5% fee)");
  ok((await raw(issuer, { TransactionType: "AccountSet", Account: issuer.classicAddress, SetFlag: 8 })).success, "issuer DefaultRipple");
  for (const h of [lp, alice, maker]) ok((await raw(h, { TransactionType: "TrustSet", Account: h.classicAddress, LimitAmount: { currency: "AGT", issuer: issuer.classicAddress, value: "1000000" } })).success, "trustline");
  for (const h of [lp, alice, maker]) ok((await raw(issuer, { TransactionType: "Payment", Account: issuer.classicAddress, Destination: h.classicAddress, Amount: { currency: "AGT", issuer: issuer.classicAddress, value: "2000" } })).success, "issued 2000 AGT");
  const create = await raw(lp, { TransactionType: "AMMCreate", Account: lp.classicAddress, Amount: "50000000", Amount2: { currency: "AGT", issuer: issuer.classicAddress, value: "500" }, TradingFee: 500 });
  ok(create.success, `AMMCreate ${create.result} (${create.hash.slice(0, 10)}…)`);

  console.log("1) pool + order book");
  const pool = await getAmm(ledger, "XRP", AGT);
  ok(pool.amount1 === 50 && pool.amount2 === 500 && pool.tradingFeePct === 0.5, `pool: ${pool.amount1} XRP / ${pool.amount2} AGT, fee ${pool.tradingFeePct}%, spot ${pool.spotPrice} AGT per XRP`);
  const order = await prepareLimitOrder(ledger, { account: maker.classicAddress, sell: AGT, sellAmount: "50", buy: "XRP", buyAmount: "6" });
  const placed = await run(maker, order);
  ok(placed.success, "maker's resting order: sell 50 AGT for 6 XRP (0.12 XRP each)");
  ok(matchesIntent({ tool: "limit_order", input: { account: maker.classicAddress, sell: AGT, sellAmount: "50", buy: "XRP", buyAmount: "6" } }, await onLedger(placed.hash)).ok, "limit-order intent matches the ledger copy");
  const book = await getOrderBook(ledger, AGT, "XRP");
  ok(book.asks.length > 0 && Math.abs(book.asks[0].price - 0.12) < 1e-9, `order book ask: ${book.asks[0].amount} AGT @ ${book.asks[0].price} XRP`);
  ok((await listOffers(ledger, maker.classicAddress)).some((o) => o.sequence === order.tx.Sequence), "maker's order listed");

  console.log("2) swap XRP → AGT");
  const q = await quoteSwap(ledger, "XRP", AGT, "5");
  ok(q.ammOut > q.bookOut && q.via === "AMM pool", `quote 5 XRP → ≈${q.expectedOut.toFixed(3)} AGT (AMM ${q.ammOut.toFixed(3)} vs book ${q.bookOut.toFixed(3)}), impact ${q.priceImpactPct?.toFixed(2)}%`);
  const s1 = await prepareSwap(ledger, { account: alice.classicAddress, sell: "XRP", amount: "5", buy: AGT, slippagePct: 1 });
  const r1 = await run(alice, s1);
  ok(r1.success, `swap validated ${r1.result}; changes: ${r1.changes?.join(", ")}`);
  const got = Number(r1.changes?.find((x) => x.endsWith("AGT"))?.split(" ")[0]);
  ok(got >= Number(s1.minOut), `received ${got} AGT ≥ minimum ${s1.minOut}`);
  ok(matchesIntent({ tool: "swap", input: { account: alice.classicAddress, sell: "XRP", amount: "5", buy: AGT, minOut: s1.minOut } }, await onLedger(r1.hash)).ok, "swap intent matches the ledger copy");

  console.log("3) impossible minimum → fill-or-kill: nothing trades");
  const s2 = await prepareSwap(ledger, { account: alice.classicAddress, sell: "XRP", amount: "5", buy: AGT, minOut: "1000" });
  const r2 = await run(alice, s2);
  ok(!r2.success && r2.result === "tecKILLED", `ledger result ${r2.result} — killed, not filled`);
  ok((r2.changes ?? []).every((x) => x.endsWith("XRP")) && Math.abs(Number(r2.changes?.[0]?.split(" ")[0])) < 0.001, `only the network fee spent: ${r2.changes?.join(", ")}`);

  console.log("4) swap back AGT → XRP");
  const r3 = await run(alice, await prepareSwap(ledger, { account: alice.classicAddress, sell: AGT, amount: "20", buy: "XRP", slippagePct: 1 }));
  ok(r3.success, `20 AGT → XRP validated; changes: ${r3.changes?.join(", ")}`);

  console.log("5) liquidity: deposit both assets → withdraw half → withdraw all");
  const d = await prepareAmmDeposit(ledger, { account: alice.classicAddress, asset1: "XRP", asset2: AGT, amount1: "2" });
  const rd = await run(alice, d);
  ok(rd.success, `deposit validated: ${rd.changes?.join(", ")}`);
  ok(matchesIntent({ tool: "amm_deposit", input: { account: alice.classicAddress, asset1: "XRP", asset2: AGT, amount1: "2", amount2: d.amount2 } }, await onLedger(rd.hash)).ok, "deposit intent matches the ledger copy");
  const pos = await getAmmPosition(ledger, alice.classicAddress, await getAmm(ledger, "XRP", AGT));
  ok(pos.lpTokens > 0, `alice holds ${pos.lpTokens} LP (${pos.sharePct.toFixed(3)}% ≈ ${pos.worth1.toFixed(4)} XRP + ${pos.worth2.toFixed(4)} AGT)`);
  const half = String(Number((pos.lpTokens / 2).toPrecision(10)));
  const rw = await run(alice, await prepareAmmWithdraw(ledger, { account: alice.classicAddress, asset1: "XRP", asset2: AGT, lpTokens: half }));
  ok(rw.success, `withdrew half: ${rw.changes?.join(", ")}`);
  ok(matchesIntent({ tool: "amm_withdraw", input: { account: alice.classicAddress, asset1: "XRP", asset2: AGT, lpTokens: half } }, await onLedger(rw.hash)).ok, "withdraw intent matches the ledger copy");
  const ra = await run(alice, await prepareAmmWithdraw(ledger, { account: alice.classicAddress, asset1: "XRP", asset2: AGT, all: true }));
  ok(ra.success, `withdrew all: ${ra.changes?.join(", ")}`);
  ok((await getAmmPosition(ledger, alice.classicAddress, await getAmm(ledger, "XRP", AGT))).lpTokens === 0, "no LP left");

  console.log("6) cancel the maker's resting order");
  const rc = await run(maker, await prepareOfferCancel(ledger, { account: maker.classicAddress, sequence: order.tx.Sequence! }));
  ok(rc.success && !(await listOffers(ledger, maker.classicAddress)).length, "order cancelled, book side cleared");
  await ledger.close();
  console.log("\nALL GREEN — DEX & AMM on public Testnet: book, quotes, fill-or-kill swaps, limit orders, liquidity.");
}
main().catch((e) => { console.error(e); process.exit(1); });
