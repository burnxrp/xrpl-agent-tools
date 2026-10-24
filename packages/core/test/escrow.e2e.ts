// End-to-end native escrow on public Testnet. Uses ONLY the tool library + public XRPL nodes + the public faucet.
//   npm run test:escrow                     (default Testnet endpoints)
//   XRPL_ENDPOINTS=wss://testnet.xrpl-labs.com npm run test:escrow   (prove independence of any one endpoint)
import { Wallet } from "xrpl";
import { Ledger, getAccount, prepareEscrowCreate, prepareEscrowFinish, prepareEscrowCancel, listEscrows,
         submitSigned, verifyTx, signLocally } from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForLedgerTime(ledger: Ledger, rippleTime: number) {
  for (;;) { if ((await ledger.validatedCloseTime()) > rippleTime + 1) return; await sleep(2000); }
}

async function main() {
  const ledger = new Ledger({ network: "testnet" });
  const client = await ledger.client();
  console.log(`network: ${ledger.network} via ${ledger.endpoint}`);

  console.log("1) fund two fresh wallets from the public Testnet faucet");
  const { wallet: alice } = await client.fundWallet();
  const { wallet: bob } = await client.fundWallet();
  console.log(`  alice ${alice.classicAddress}\n  bob   ${bob.classicAddress}`);
  const bob0 = Number((await getAccount(ledger, bob.classicAddress)).balanceXrp);

  console.log("2) escrow A: create → (early finish refused) → finish after release time");
  const pa = await prepareEscrowCreate(ledger, { account: alice.classicAddress, destination: bob.classicAddress,
                                                 amount: "5", finishAfter: "+15s", cancelAfter: "+10m", memo: "agent-console e2e" });
  console.log("  summary:", pa.summary);
  const ca = await submitSigned(ledger, signLocally(alice.seed!, pa.tx).txBlob);
  ok(ca.success && ca.validated, `EscrowCreate validated tesSUCCESS (${ca.hash.slice(0, 12)}… ledger ${ca.ledgerIndex})`);
  ok(!!ca.escrow, `escrow reference returned: ${ca.escrow!.owner.slice(0, 8)}…#${ca.escrow!.sequence}`);
  const listed = await listEscrows(ledger, alice.classicAddress);
  ok(listed.some((e) => e.sequence === ca.escrow!.sequence && e.amountXrp === "5"), "escrow visible in validated ledger state");
  let refused = false;
  try { await prepareEscrowFinish(ledger, { account: bob.classicAddress, ...ca.escrow! }); } catch { refused = true; }
  ok(refused, "finishing before the release time is refused (no wasted fee)");
  await waitForLedgerTime(ledger, pa.tx.FinishAfter!);
  const pf = await prepareEscrowFinish(ledger, { account: bob.classicAddress, ...ca.escrow! });
  const fa = await submitSigned(ledger, signLocally(bob.seed!, pf.tx).txBlob);
  ok(fa.success, `EscrowFinish validated tesSUCCESS (${fa.hash.slice(0, 12)}…)`);
  const bob1 = Number((await getAccount(ledger, bob.classicAddress)).balanceXrp);
  ok(bob1 > bob0 + 4.99, `bob received the XRP (${bob0} → ${bob1})`);

  console.log("3) escrow B: create → wait past cancelAfter → cancel (XRP returns to alice)");
  const pb = await prepareEscrowCreate(ledger, { account: alice.classicAddress, destination: bob.classicAddress,
                                                 amount: "3", finishAfter: "+10s", cancelAfter: "+25s" });
  const cb = await submitSigned(ledger, signLocally(alice.seed!, pb.tx).txBlob);
  ok(cb.success, `EscrowCreate B validated (${cb.hash.slice(0, 12)}…)`);
  const a1 = Number((await getAccount(ledger, alice.classicAddress)).balanceXrp);
  await waitForLedgerTime(ledger, pb.tx.CancelAfter!);
  const pc = await prepareEscrowCancel(ledger, { account: alice.classicAddress, ...cb.escrow! });
  const cc = await submitSigned(ledger, signLocally(alice.seed!, pc.tx).txBlob);
  ok(cc.success, `EscrowCancel validated tesSUCCESS (${cc.hash.slice(0, 12)}…)`);
  const a2 = Number((await getAccount(ledger, alice.classicAddress)).balanceXrp);
  ok(a2 > a1 + 2.99, `alice got the 3 XRP back (${a1} → ${a2})`);
  ok((await listEscrows(ledger, alice.classicAddress)).length === 0, "no escrows left open");

  console.log("4) independent re-verification of every hash");
  for (const h of [ca.hash, fa.hash, cb.hash, cc.hash]) ok((await verifyTx(ledger, h)).success, `verified ${h.slice(0, 12)}… → ${(await verifyTx(ledger, h)).explorer}`);
  await ledger.close();
  console.log("\nALL GREEN — native escrow create/finish/cancel on public Testnet, no private infrastructure.");
}
main().catch(async (e) => { console.error(e); process.exit(1); });
