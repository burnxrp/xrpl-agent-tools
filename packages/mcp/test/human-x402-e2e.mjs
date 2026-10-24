// x402 from a HUMAN wallet on public Testnet: the agent requests a paid URL → approval; the human approves the way the
// console does (fresh quote → wallet signs → adapter pays the seller) → the agent gets the paid response + ledger proof.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, X402Facilitator, x402Gate, x402Requirement, fromB64json, prepareX402Payment, signLocally, HEADER_SIGNATURE } from "@xrpl-agent/core";

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const ledger = new Ledger({ network: "testnet" }); const c = await ledger.client();
const [{ wallet: human }, { wallet: seller }, { wallet: other }] = await Promise.all([c.fundWallet(), c.fundWallet(), c.fundWallet()]);

// a seller whose price / payee we can change between the request and the approval
const shop = { price: "0.2", payTo: seller.classicAddress };
const fac = new X402Facilitator(ledger), offers = new Map(); let n = 0;
const server = createServer(async (req, res) => {
  if (req.url === "/free") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"free":true}'); }
  const sig = req.headers[HEADER_SIGNATURE.toLowerCase()];
  let accepts = [];
  if (sig) { try { accepts = offers.get(String(fromB64json(sig).accepted?.extra?.invoiceId)) ?? []; } catch {} }
  if (!accepts.length) { const id = `H-${++n}`; accepts = [x402Requirement({ network: "testnet", payTo: shop.payTo, amount: shop.price, asset: "XRP", invoiceId: id, maxTimeoutSeconds: 120 })]; offers.set(id, accepts); }
  const g = await x402Gate(fac, sig, accepts, { url: "http://127.0.0.1/report", serviceName: "Report shop" });
  if (!g.paid) { res.writeHead(402, g.headers); return res.end(JSON.stringify(g.body)); }
  const { headers, settlement } = await g.settle();
  res.writeHead(settlement.success ? 200 : 402, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify(settlement.success ? { report: "Q4 is up 12%" } : { error: settlement.errorReason }));
});
await new Promise((r) => server.listen(4051, "127.0.0.1", r));
const URL0 = "http://127.0.0.1:4051/report";

const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: mkdtempSync(join(tmpdir(), "xrpl-agent-hx-")), XRPL_AGENT_UI_PORT: "7488" } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text; if (r.isError) throw new Error(t); return JSON.parse(t); };
const ni = await call("xrpl_network_info");
const base = ni.console.split("/#/")[0], token = new URL(ni.console.replace("#/", "")).searchParams.get("token");
const api = async (path, b) => { const r = await fetch(`${base}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Console-Token": token }, body: JSON.stringify(b ?? {}) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
const refused = async (p, m) => { try { await p; } catch (e) { return ok(true, `${m} → ${e.message.replace(/^Error: /, "").slice(0, 90)}`); } ok(false, m + " should be refused"); };
const approveLikeConsole = async (id, mutate = (tx) => tx) => {           // what the console's Approve & sign does
  const { requirement } = await api(`/approvals/${id}/x402/quote`);
  const tx = mutate((await prepareX402Payment(ledger, human.classicAddress, requirement)).tx);
  return api(`/approvals/${id}/x402/redeem`, { signedTxBlob: signLocally(human.seed, tx).txBlob });
};

console.log("1) free URLs need no approval");
const free = await call("xrpl_x402_fetch", { account: human.classicAddress, url: "http://127.0.0.1:4051/free" });
ok(free.status === "no_payment_needed" && free.response.body === '{"free":true}', "returned directly");

console.log("2) the happy path");
const q = await call("xrpl_x402_fetch", { account: human.classicAddress, url: URL0 });
ok(q.status === "awaiting_human_approval" && /Pay 0\.2 XRP to r/.test(q.summary), `queued: ${q.summary}`);
const s0 = Number((await c.request({ command: "account_info", account: seller.classicAddress })).result.account_data.Balance);
const done = await approveLikeConsole(q.approval_id);
ok(done.status === "confirmed" && done.response.status === 200 && done.proof.success, `human approved → seller paid → ${done.response.body}`);
const st = await call("xrpl_approval_status", { approval_id: q.approval_id });
ok(st.status === "confirmed" && JSON.parse(st.response.body).report === "Q4 is up 12%" && st.proof.delivered === "0.2 XRP", "the agent gets the paid response + ledger proof");
ok(Number((await c.request({ command: "account_info", account: seller.classicAddress })).result.account_data.Balance) - s0 === 200000, "seller received exactly 0.2 XRP");
await refused(api(`/approvals/${q.approval_id}/x402/redeem`, { signedTxBlob: "00" }), "redeeming again");

console.log("3) the human is protected after approving the request");
const q2 = await call("xrpl_x402_fetch", { account: human.classicAddress, url: URL0 });
shop.price = "0.5";
await refused(api(`/approvals/${q2.approval_id}/x402/quote`), "price went up between request and approval");
shop.price = "0.1";
const cheaper = await approveLikeConsole(q2.approval_id);
ok(cheaper.status === "confirmed" && cheaper.proof.delivered === "0.1 XRP", "price went down → paid the lower 0.1 XRP");
const q3 = await call("xrpl_x402_fetch", { account: human.classicAddress, url: URL0 });
shop.payTo = other.classicAddress;
await refused(api(`/approvals/${q3.approval_id}/x402/quote`), "payee changed");
shop.payTo = seller.classicAddress;
await refused(approveLikeConsole(q3.approval_id, (tx) => ({ ...tx, Destination: other.classicAddress })), "a signed payment to someone else");
await refused(approveLikeConsole(q3.approval_id, (tx) => ({ ...tx, Amount: "1000" })), "a signed payment for less (seller would refuse)");
await refused(api(`/approvals/${q3.approval_id}/x402/redeem`, { signedTxBlob: "1200" }), "an undecodable payment");
const q4 = await call("xrpl_x402_fetch", { account: human.classicAddress, url: URL0 });
await refused(api(`/approvals/${q4.approval_id}/x402/redeem`, { signedTxBlob: "1200" }), "redeem without a current quote");
await refused(api(`/approvals/${q3.approval_id}/result`, { hash: "0".repeat(64) }), "the plain /result path for an x402 approval");
await refused(call("xrpl_x402_fetch", { account: human.classicAddress, url: URL0, max_amount: "0.05" }), "max_amount 0.05");

console.log("ALL HUMAN-WALLET X402 CHECKS PASSED");
server.close(); await mcp.close(); await ledger.close(); process.exit(0);
