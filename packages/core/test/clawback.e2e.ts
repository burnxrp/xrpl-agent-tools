// Issuer clawback end to end on public Testnet.
import { Wallet } from "xrpl";
import { Ledger, getClawbackStatus, listHolders, prepareEnableClawback, prepareClawback, submitSigned, signLocally,
         matchesIntent } from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const refused = async (p: Promise<unknown>, m: string) => { try { await p; } catch (e) { return ok(true, `${m} → ${(e as Error).message.slice(0, 80)}`); } ok(false, `${m} should be refused`); };

async function main() {
  const ledger = new Ledger({ network: "testnet" });
  const c = await ledger.client();
  console.log(`network: ${ledger.network} via ${ledger.endpoint}`);
  const [issuer, plain, holder] = await Promise.all([1, 2, 3].map(async () => (await c.fundWallet()).wallet));
  const raw = async (w: Wallet, tx: any) => submitSigned(ledger, signLocally(w.seed!, await c.autofill(tx)).txBlob);
  const run = async (w: Wallet, p: { tx: any }) => submitSigned(ledger, signLocally(w.seed!, p.tx).txBlob);
  const onLedger = async (h: string) => (await ledger.request<any>({ command: "tx", transaction: h })).tx_json;

  console.log("1) enable clawback on a fresh issuer");
  let st = await getClawbackStatus(ledger, issuer.classicAddress);
  ok(!st.enabled && st.canEnable, "fresh issuer: not enabled, can enable");
  const en = await run(issuer, await prepareEnableClawback(ledger, { account: issuer.classicAddress }));
  ok(en.success, `AccountSet asfAllowTrustLineClawback → ${en.result}`);
  ok(matchesIntent({ tool: "clawback_enable", input: { account: issuer.classicAddress } }, await onLedger(en.hash)).ok, "enable intent matches the ledger copy");
  ok((await getClawbackStatus(ledger, issuer.classicAddress)).enabled, "status now enabled");
  await refused(prepareEnableClawback(ledger, { account: issuer.classicAddress }), "enabling twice");

  console.log("2) issue a token and claw some back");
  await raw(holder, { TransactionType: "TrustSet", Account: holder.classicAddress, LimitAmount: { currency: "CLW", issuer: issuer.classicAddress, value: "1000000" } });
  await raw(issuer, { TransactionType: "Payment", Account: issuer.classicAddress, Destination: holder.classicAddress, Amount: { currency: "CLW", issuer: issuer.classicAddress, value: "100" } });
  const hs = await listHolders(ledger, issuer.classicAddress);
  ok(hs.length === 1 && hs[0].holder === holder.classicAddress && hs[0].balance === 100, `holders: ${hs[0].holder.slice(0, 8)}… holds ${hs[0].balance} ${hs[0].currency}`);
  const input = { account: issuer.classicAddress, holder: holder.classicAddress, currency: "CLW", amount: "30" };
  const cb = await run(issuer, await prepareClawback(ledger, input));
  ok(cb.success, `Clawback 30 CLW → ${cb.result}`);
  ok(matchesIntent({ tool: "clawback", input }, await onLedger(cb.hash)).ok, "clawback intent matches the ledger copy");
  ok(!matchesIntent({ tool: "clawback", input: { ...input, amount: "10" } }, await onLedger(cb.hash)).ok, "a different amount does NOT match");
  ok((await listHolders(ledger, issuer.classicAddress))[0].balance === 70, "holder now has 70 CLW");

  console.log("3) refusals");
  await refused(prepareClawback(ledger, { ...input, amount: "71" }), "clawing more than the holder has");
  await refused(prepareClawback(ledger, { ...input, holder: plain.classicAddress }), "a holder with no line");
  await refused(prepareClawback(ledger, { ...input, account: holder.classicAddress, holder: issuer.classicAddress }), "an account without the flag");
  await raw(plain, { TransactionType: "TrustSet", Account: plain.classicAddress, LimitAmount: { currency: "CLW", issuer: issuer.classicAddress, value: "1" } });
  st = await getClawbackStatus(ledger, holder.classicAddress);
  ok(!st.canEnable && /owns/.test(st.why ?? ""), `an issuer that already owns objects can't enable: ${st.why?.slice(0, 60)}`);
  await refused(prepareEnableClawback(ledger, { account: holder.classicAddress }), "enabling after trustlines exist");

  console.log("ALL CLAWBACK CHECKS PASSED");
  await ledger.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
