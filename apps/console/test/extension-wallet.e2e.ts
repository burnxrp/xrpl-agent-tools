// Extension-wallet signing path, without a browser: (1) the signed-blob guard the console runs on whatever GemWallet /
// Crossmark return, (2) the never-applicable policy approval transaction — signed, verified, and rejected by a real node.
import { Wallet } from "xrpl";
import { Ledger, policyProofTx, verifyPolicyProof, defaultPolicy, preparePayment, signLocally, submitSigned } from "@xrpl-agent/core";
import { assertSignedMatches } from "../src/wallet";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const refused = (f: () => unknown, m: string) => { try { f(); } catch (e) { return ok(true, `${m} → ${(e as Error).message}`); } ok(false, `${m} should be refused`); };

async function main() {
  const ledger = new Ledger({ network: "testnet" }); const c = await ledger.client();
  const [{ wallet: owner }, { wallet: bob }] = await Promise.all([c.fundWallet(), c.fundWallet()]);
  const other = Wallet.generate();

  console.log("1) signed-blob guard (what an extension returns vs what the human reviewed)");
  const p = await preparePayment(ledger, { account: owner.classicAddress, destination: bob.classicAddress, amount: "3", asset: "XRP" });
  const honest = signLocally(owner.seed!, { ...p.tx, Flags: ((Number(p.tx.Flags) || 0) | 0x80000000) >>> 0, Fee: "15" }).txBlob;
  assertSignedMatches(p.tx, honest); ok(true, "same tx (+ fully-canonical flag, slightly higher fee) accepted");
  refused(() => assertSignedMatches(p.tx, signLocally(owner.seed!, { ...p.tx, Destination: other.classicAddress }).txBlob), "changed destination");
  refused(() => assertSignedMatches(p.tx, signLocally(owner.seed!, { ...p.tx, Amount: "3000000000" }).txBlob), "changed amount");
  refused(() => assertSignedMatches(p.tx, signLocally(owner.seed!, { ...p.tx, Memos: [{ Memo: { MemoData: "00" } }] }).txBlob), "added memo");
  refused(() => assertSignedMatches(p.tx, signLocally(owner.seed!, { ...p.tx, Flags: 0x00020000 }).txBlob), "added partial-payment flag");
  refused(() => assertSignedMatches(p.tx, signLocally(owner.seed!, { ...p.tx, Fee: "5000000" }).txBlob), "5 XRP fee");
  const sent = await submitSigned(ledger, honest);
  ok(sent.success, `guarded blob submitted: ${sent.result}`);

  console.log("2) policy approval transaction");
  const agent = Wallet.generate().classicAddress;
  const policy = { ...defaultPolicy(owner.classicAddress), xrp: { perTx: "20", daily: "50" }, version: 2 };
  const seq = Number((await c.request({ command: "account_info", account: owner.classicAddress })).result.account_data.Sequence);
  const proof = signLocally(owner.seed!, policyProofTx(agent, policy, seq)).txBlob;
  ok(verifyPolicyProof(agent, policy, proof).ok, "owner-signed approval verifies");
  ok(!verifyPolicyProof(agent, { ...policy, xrp: { perTx: "999", daily: "999" } }, proof).ok, "a different policy does not verify");
  ok(!verifyPolicyProof(Wallet.generate().classicAddress, policy, proof).ok, "a different agent does not verify");
  const forged = signLocally(other.seed!, { ...policyProofTx(agent, policy, 1), Account: other.classicAddress }).txBlob;
  ok(!verifyPolicyProof(agent, policy, forged).ok, `signed by someone else: ${verifyPolicyProof(agent, policy, forged).why}`);
  const live = signLocally(owner.seed!, { ...policyProofTx(agent, policy, seq), LastLedgerSequence: 99_999_999 }).txBlob;
  ok(!verifyPolicyProof(agent, policy, live).ok, `a wallet that made it applicable: ${verifyPolicyProof(agent, policy, live).why}`);
  const sub = await c.request({ command: "submit", tx_blob: proof });
  ok(!sub.result.engine_result.startsWith("tes"), `submitting the approval to a real node fails: ${sub.result.engine_result}`);
  const after = Number((await c.request({ command: "account_info", account: owner.classicAddress })).result.account_data.Sequence);
  ok(after === seq, "owner's account unchanged (no fee, no sequence used)");
  console.log("ALL EXTENSION-WALLET CHECKS PASSED");
  await ledger.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
