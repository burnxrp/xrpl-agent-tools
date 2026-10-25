// Phone approvals through Xaman, end to end on public Testnet — with a FAKE PHONE standing in for the Xaman app (it
// signs with the owner's Testnet key, or rejects / tampers / signs on the wrong network / stays silent). Everything
// else is real: the adapter's approvals, the bridge, the ledger, the x402 seller.
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
process.env.XRPL_AGENT_HOME = mkdtempSync(join(tmpdir(), "xrpl-agent-xaman-"));
const { Ledger, signLocally, submitSigned, prepareFromIntent, X402Facilitator, x402Gate, x402Requirement, fromB64json, HEADER_SIGNATURE } = await import("@xrpl-agent/core");
const { approvals } = await import("../dist/approvals.js");
const { XamanBridge } = await import("../dist/xaman.js");
const { finalizeApproval } = await import("../dist/finalize.js");
const { requestX402Approval } = await import("../dist/x402-approvals.js");

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const ledger = new Ledger({ network: "testnet" }); const c = await ledger.client();
const [{ wallet: owner }, { wallet: shop }, { wallet: other }] = await Promise.all([c.fundWallet(), c.fundWallet(), c.fundWallet()]);

class FakePhone {                       // what the Xaman app + API would do, driven by a queue of behaviours
  modes = []; results = new Map(); cancelled = new Set(); sent = [];
  async createAndSubscribe(body, cb) {
    const uuid = randomUUID(); let done; const resolved = new Promise((r) => (done = r));
    const mode = body.txjson.TransactionType === "SignIn" ? "signin" : (this.modes.shift() ?? "sign");
    this.sent.push({ uuid, body, mode });
    setTimeout(() => {
      if (mode === "silent" || this.cancelled.has(uuid)) return;
      if (mode === "signin") { this.results.set(uuid, { application: { issued_user_token: "tok-fake" }, response: { account: owner.classicAddress, hex: null } }); return done(cb({ data: { signed: true } })); }
      if (mode === "reject") return done(cb({ data: { signed: false } }));
      const tx = { ...body.txjson, ...(mode === "tamper" ? { Destination: other.classicAddress } : {}) };
      this.results.set(uuid, { response: { account: owner.classicAddress, hex: signLocally(owner.seed, tx).txBlob, environment_networkid: mode === "wrongnet" ? 0 : 1 } });
      done(cb({ data: { signed: true } }));
    }, 400);
    return { created: { uuid, next: { always: `https://xumm.app/sign/${uuid}` }, refs: { qr_png: `https://xumm.app/sign/${uuid}_q.png` } }, resolved };
  }
  async get(uuid) { return this.results.get(uuid); }
  async cancel(uuid) { this.cancelled.add(uuid); return { cancelled: true }; }
}
const phone = new FakePhone();
const bridge = new XamanBridge(ledger, phone, { expireMinutes: 10 });
const until = async (id, pred, s = 60) => { for (let i = 0; i < s * 2; i++) { const a = approvals.get(id); if (pred(a)) return a; await new Promise((r) => setTimeout(r, 500)); } return approvals.get(id); };
const pay = (amount, account = owner.classicAddress) => approvals.add({ network: "testnet", intent: { tool: "payment", input: { account, destination: shop.classicAddress, amount, asset: "XRP" } },
  summary: `Send ${amount} XRP`, details: {}, warnings: [] });

console.log("1) not linked → nothing goes to a phone");
const a0 = pay("1");
ok(!bridge.wants(a0) && (await until(a0.id, () => false, 1)).phone === undefined, "approval stays console-only");
approvals.update(a0.id, { status: "rejected" });

console.log("2) link the phone (Xaman sign-in)");
const link = await bridge.startLink();
ok(/xumm\.app\/sign\//.test(link.url) && !!link.qr, `link URL + QR returned: ${link.url.slice(0, 40)}…`);
for (let i = 0; i < 20 && !bridge.status().linked; i++) await new Promise((r) => setTimeout(r, 250));
const st = bridge.status();
ok(st.linked && st.account === owner.classicAddress, `linked to ${st.account}`);
ok((statSync(join(process.env.XRPL_AGENT_HOME, "xaman.json")).mode & 0o777) === 0o600, "user token stored owner-only (0600)");

console.log("3) approve on the phone");
const a1 = pay("2");
let r1 = await until(a1.id, (a) => a.status !== "pending" && a.status !== "submitted");
const sent1 = phone.sent.at(-1);
ok(sent1.body.user_token === "tok-fake" && sent1.body.options.submit === false && sent1.body.options.force_network === "TESTNET" && sent1.body.custom_meta.identifier === a1.id,
   "pushed to the linked phone: submit:false, force_network TESTNET, approval id attached");
const validated = Number((await ledger.request({ command: "ledger", ledger_index: "validated" })).ledger_index);
ok(sent1.body.txjson.LastLedgerSequence > validated + 100, `transaction stays valid while the phone request is open (LLS +${sent1.body.txjson.LastLedgerSequence - validated})`);
ok(r1.status === "confirmed" && r1.proof.success && r1.proof.delivered === "2 XRP" && r1.phone.state === "signed", `confirmed on ledger ${r1.proof.ledgerIndex}: ${r1.proof.delivered}`);

console.log("4) refusals");
phone.modes.push("reject"); const a2 = pay("1");
ok((await until(a2.id, (a) => a.status !== "pending")).status === "rejected", "rejected in Xaman → approval rejected");
phone.modes.push("tamper"); const a3 = pay("1");
const r3 = await until(a3.id, (a) => a.status !== "pending");
ok(r3.status === "failed" && /changed "Destination"/.test(r3.note), `phone returned a different transaction → ${r3.note}`);
phone.modes.push("wrongnet"); const a4 = pay("1");
const r4 = await until(a4.id, (a) => a.status !== "pending");
ok(r4.status === "failed" && /network 0/.test(r4.note), `signed on mainnet → ${r4.note}`);
const a5 = pay("1", other.classicAddress);
ok(!bridge.wants(a5) && (await until(a5.id, () => false, 1)).phone === undefined, "another wallet's approval is never pushed to this phone");
approvals.update(a5.id, { status: "rejected" });

console.log("5) the console wins the race → the phone request is withdrawn");
phone.modes.push("silent"); const a6 = pay("1");
await until(a6.id, (a) => a.phone?.state === "sent", 10);
const prepared = await prepareFromIntent(ledger, a6.intent);
const proof = await submitSigned(ledger, signLocally(owner.seed, prepared.tx).txBlob);
await finalizeApproval(ledger, a6.id, proof.hash);
const r6 = await until(a6.id, (a) => a.phone?.state === "cancelled", 10);
ok(r6.status === "confirmed" && r6.phone.state === "cancelled" && phone.cancelled.has(r6.phone.uuid), "approved in the console; the Xaman request was cancelled");

console.log("6) x402 paid request approved on the phone");
const fac = new X402Facilitator(ledger), offers = new Map();
const server = createServer(async (req, res) => {
  const sig = req.headers[HEADER_SIGNATURE.toLowerCase()];
  let accepts = []; if (sig) { try { accepts = offers.get(String(fromB64json(sig).accepted?.extra?.invoiceId)) ?? []; } catch {} }
  if (!accepts.length) { const id = randomUUID(); accepts = [x402Requirement({ network: "testnet", payTo: shop.classicAddress, amount: "0.2", asset: "XRP", invoiceId: id, maxTimeoutSeconds: 300 })]; offers.set(id, accepts); }
  const g = await x402Gate(fac, sig, accepts, { url: "http://127.0.0.1/data" });
  if (!g.paid) { res.writeHead(402, g.headers); return res.end(JSON.stringify(g.body)); }
  const { headers, settlement } = await g.settle();
  res.writeHead(settlement.success ? 200 : 402, { ...headers, "Content-Type": "application/json" }); res.end(settlement.success ? '{"data":"paid via phone"}' : "{}");
});
await new Promise((r) => server.listen(4071, "127.0.0.1", r));
const q = await requestX402Approval(ledger, { account: owner.classicAddress, url: "http://127.0.0.1:4071/data" });
const r7 = await until(q.approval.id, (a) => a.status !== "pending" && a.status !== "submitted");
ok(r7.status === "confirmed" && r7.response.status === 200 && JSON.parse(r7.response.body).data === "paid via phone" && r7.proof.delivered === "0.2 XRP",
   `paid request approved on the phone → ${r7.response.body}`);
ok(phone.sent.at(-1).body.options.expire <= 5, `x402 phone request expires with the seller's invoice (${phone.sent.at(-1).body.options.expire} min)`);

console.log("ALL XAMAN PHONE-APPROVAL CHECKS PASSED");
server.close(); await ledger.close(); process.exit(0);
