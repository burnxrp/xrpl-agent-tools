// End-to-end payments on public Testnet: XRP + an issued token with a transfer fee. Public nodes + faucet only.
import { Wallet } from "xrpl";
import { Ledger, getBalances, preparePayment, submitSigned, signLocally, matchesIntent, currencyCode } from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
async function refused(p: Promise<unknown>, m: string) {
  try { await p; } catch (e) { return ok(true, `${m} → refused: ${(e as Error).message.slice(0, 80)}`); }
  ok(false, `${m} should have been refused`);
}

async function main() {
  const ledger = new Ledger({ network: "testnet" });
  const c = await ledger.client();
  console.log(`network: ${ledger.network} via ${ledger.endpoint}`);
  const [{ wallet: alice }, { wallet: bob }, { wallet: issuer }] = [await c.fundWallet(), await c.fundWallet(), await c.fundWallet()];
  const send = async (w: Wallet, tx: any) => submitSigned(ledger, signLocally(w.seed!, await c.autofill(tx)).txBlob);
  const bal = async (a: string, cur?: string) => { const b = await getBalances(ledger, a);
    return cur ? Number(b.tokens.find((t) => t.currency === cur)?.balance ?? 0) : Number(b.xrp.balanceXrp); };

  console.log("1) XRP payments");
  const p1 = await preparePayment(ledger, { account: alice.classicAddress, destination: bob.classicAddress, amount: "12.5", asset: "XRP", memo: "agent payment" });
  const r1 = await submitSigned(ledger, signLocally(alice.seed!, p1.tx).txBlob);
  ok(r1.success && r1.delivered === "12.5 XRP", `12.5 XRP alice→bob validated, delivered ${r1.delivered}`);
  ok(matchesIntent({ tool: "payment", input: { account: alice.classicAddress, destination: bob.classicAddress, amount: "12.5", asset: "XRP" } }, p1.tx).ok, "intent matches the signed payment");
  ok(!matchesIntent({ tool: "payment", input: { account: alice.classicAddress, destination: bob.classicAddress, amount: "1.25", asset: "XRP" } }, p1.tx).ok, "a different amount fails the intent check");
  // Regression: the adapter checks the LEDGER's copy, where API v2 names the amount DeliverMax.
  const onLedger = (await ledger.request<any>({ command: "tx", transaction: r1.hash })).tx_json;
  ok(matchesIntent({ tool: "payment", input: { account: alice.classicAddress, destination: bob.classicAddress, amount: "12.5", asset: "XRP" } }, onLedger).ok,
     `intent matches the validated ledger copy (amount field: ${"Amount" in onLedger ? "Amount" : "DeliverMax"})`);
  const fresh = Wallet.generate().classicAddress;
  await refused(preparePayment(ledger, { account: alice.classicAddress, destination: fresh, amount: "0.5", asset: "XRP" }), "0.5 XRP to a brand-new address");
  const p2 = await preparePayment(ledger, { account: alice.classicAddress, destination: fresh, amount: "2", asset: "XRP" });
  ok(p2.warnings.some((w) => w.includes("activates")), "activation warning shown");
  ok((await submitSigned(ledger, signLocally(alice.seed!, p2.tx).txBlob)).success, "2 XRP activates the new address");

  console.log("2) issued token AGENTCOIN with a 1% transfer fee");
  ok((await send(issuer, { TransactionType: "AccountSet", Account: issuer.classicAddress, SetFlag: 8, TransferRate: 1_010_000_000 })).success, "issuer: DefaultRipple + 1% transfer fee");
  const CUR = "AGENTCOIN", code = currencyCode(CUR);
  for (const w of [alice, bob]) ok((await send(w, { TransactionType: "TrustSet", Account: w.classicAddress,
    LimitAmount: { currency: code, issuer: issuer.classicAddress, value: "1000000" } })).success, `${w === alice ? "alice" : "bob"} trusts ${CUR}`);
  const pIssue = await preparePayment(ledger, { account: issuer.classicAddress, destination: alice.classicAddress, amount: "1000", asset: { currency: CUR, issuer: issuer.classicAddress } });
  ok((await submitSigned(ledger, signLocally(issuer.seed!, pIssue.tx).txBlob)).success, "issuer sends alice 1000 AGENTCOIN");
  await refused(preparePayment(ledger, { account: alice.classicAddress, destination: fresh, amount: "5", asset: { currency: CUR, issuer: issuer.classicAddress } }), "token to an address with no trustline");
  await refused(preparePayment(ledger, { account: alice.classicAddress, destination: bob.classicAddress, amount: "995", asset: { currency: CUR, issuer: issuer.classicAddress } }), "995 when the 1% fee needs 1004.95");

  console.log("3) holder → holder token payment (fee paid by sender, recipient gets exactly the amount)");
  const pT = await preparePayment(ledger, { account: alice.classicAddress, destination: bob.classicAddress, amount: "100", asset: { currency: CUR, issuer: issuer.classicAddress } });
  ok((pT.tx.SendMax as any)?.value === "101", `SendMax covers the fee: ${(pT.tx.SendMax as any)?.value}`);
  const rT = await submitSigned(ledger, signLocally(alice.seed!, pT.tx).txBlob);
  ok(rT.success && rT.delivered === `100 ${CUR}`, `validated, delivered ${rT.delivered}`);
  ok((await bal(bob.classicAddress, CUR)) === 100, "bob holds exactly 100 AGENTCOIN");
  ok((await bal(alice.classicAddress, CUR)) === 899, "alice paid 101 (100 + 1% fee) → 899 left");
  const tOnLedger = (await ledger.request<any>({ command: "tx", transaction: rT.hash })).tx_json;
  ok(matchesIntent({ tool: "payment", input: { account: alice.classicAddress, destination: bob.classicAddress, amount: "100", asset: { currency: CUR, issuer: issuer.classicAddress } } }, tOnLedger).ok, "token intent matches the validated ledger copy");
  await ledger.close();
  console.log("\nALL GREEN — XRP + issued-token payments on public Testnet, validated, exact delivery, no private infrastructure.");
}
main().catch((e) => { console.error(e); process.exit(1); });
