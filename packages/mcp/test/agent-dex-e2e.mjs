// DEX & AMM through MCP on public Testnet: approval-based swap/deposit/withdraw (the human step is done the way the
// console does it — re-prepare from the stored intent, sign locally, submit, report the hash) + autonomous agent swaps.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, prepareSwap, prepareAmmDeposit, prepareAmmWithdraw, signLocally, submitSigned } from "@xrpl-agent/core";

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const home = mkdtempSync(join(tmpdir(), "xrpl-agent-dex-"));
const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: home, XRPL_AGENT_UI_PORT: "7482" } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text;
  if (r.isError) throw new Error(t); return JSON.parse(t); };
const refused = async (p, m) => { try { await p; } catch (e) { return ok(true, `${m} → ${e.message.replace(/^Error: /, "").slice(0, 70)}`); } ok(false, m + " should be refused"); };

const ledger = new Ledger({ network: "testnet" }); const c = await ledger.client();
const [issuer, lp, human] = await Promise.all([1, 2, 3].map(async () => (await c.fundWallet()).wallet));
const raw = async (w, tx) => submitSigned(ledger, signLocally(w.seed, await c.autofill(tx)).txBlob);
const AGT = { currency: "AGT", issuer: issuer.classicAddress };
console.log("setup: AGT token + 50 XRP / 500 AGT pool");
await raw(issuer, { TransactionType: "AccountSet", Account: issuer.classicAddress, SetFlag: 8 });
for (const h of [lp, human]) {
  await raw(h, { TransactionType: "TrustSet", Account: h.classicAddress, LimitAmount: { ...AGT, value: "1000000" } });
  await raw(issuer, { TransactionType: "Payment", Account: issuer.classicAddress, Destination: h.classicAddress, Amount: { ...AGT, value: "2000" } });
}
ok((await raw(lp, { TransactionType: "AMMCreate", Account: lp.classicAddress, Amount: "50000000", Amount2: { ...AGT, value: "500" }, TradingFee: 500 })).success, "AMM created");

const ni = await call("xrpl_network_info");
const base = ni.console.split("/#/")[0], token = new URL(ni.console.replace("#/", "")).searchParams.get("token");
async function humanApproves(approvalId, prepareFresh) {     // what the console does when the owner clicks Approve & sign
  const proof = await submitSigned(ledger, signLocally(human.seed, (await prepareFresh()).tx).txBlob);
  await fetch(`${base}/api/approvals/${approvalId}/result`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Console-Token": token }, body: JSON.stringify({ hash: proof.hash }) });
  for (let i = 0; i < 20; i++) { const s = await call("xrpl_approval_status", { approval_id: approvalId }); if (s.status !== "pending") return s; await new Promise((r) => setTimeout(r, 1500)); }
}

console.log("1) agent reads the market");
const info = await call("xrpl_amm_info", { asset1: "XRP", asset2: AGT, account: lp.classicAddress });
ok(info.amount1 === 50 && info.amount2 === 500 && info.position.sharePct > 99, `pool ${info.amount1} XRP / ${info.amount2} AGT, fee ${info.tradingFeePct}%, LP owns ${info.position.sharePct.toFixed(1)}%`);
const q = await call("xrpl_swap_quote", { sell: "XRP", amount: "5", buy: AGT });
ok(q.expectedOut > 44, `quote 5 XRP → ≈${q.expectedOut.toFixed(3)} AGT via ${q.via}`);

console.log("2) approval-based swap for the human's wallet");
const sw = await call("xrpl_swap", { account: human.classicAddress, sell: "XRP", amount: "5", buy: AGT, slippage_pct: 1 });
ok(sw.status === "awaiting_human_approval" && sw.review_url.includes(sw.approval_id), `queued ${sw.approval_id}: ${sw.summary}`);
const appr = (await (await fetch(`${base}/api/approvals`, { headers: { "X-Agent-Console-Token": token } })).json()).approvals.find((a) => a.id === sw.approval_id);
const s1 = await humanApproves(sw.approval_id, () => prepareSwap(ledger, appr.intent.input));
ok(s1.status === "confirmed" && s1.proof.changes.some((x) => x.includes("AGT")), `confirmed on ledger: ${s1.proof.changes.join(", ")}`);

console.log("3) approval-based deposit + withdraw");
const dep = await call("xrpl_amm_deposit", { account: human.classicAddress, asset1: "XRP", asset2: AGT, amount1: "5" });
const depIntent = (await (await fetch(`${base}/api/approvals`, { headers: { "X-Agent-Console-Token": token } })).json()).approvals.find((a) => a.id === dep.approval_id).intent.input;
const s2 = await humanApproves(dep.approval_id, () => prepareAmmDeposit(ledger, depIntent));
ok(s2.status === "confirmed", `deposit confirmed: ${s2.proof.changes.join(", ")}`);
const wd = await call("xrpl_amm_withdraw", { account: human.classicAddress, asset1: "XRP", asset2: AGT, all: true });
const s3 = await humanApproves(wd.approval_id, () => prepareAmmWithdraw(ledger, { account: human.classicAddress, asset1: "XRP", asset2: AGT, all: true }));
ok(s3.status === "confirmed", `withdraw-all confirmed: ${s3.proof.changes.join(", ")}`);
const evil = await call("xrpl_swap", { account: human.classicAddress, sell: "XRP", amount: "1", buy: AGT });
const s4 = await humanApproves(evil.approval_id, () => prepareSwap(ledger, { account: human.classicAddress, sell: "XRP", amount: "2", buy: AGT }));
ok(s4.status === "failed", `a different transaction reported for an approval is rejected: ${s4.note?.slice(0, 60)}`);

console.log("4) autonomous swaps from an agent account (policy 10 XRP/tx, 25/day)");
const acct = await call("xrpl_agent_account_create", { owner: human.classicAddress, label: "trader", fund_from_faucet: true });
const a1 = await call("xrpl_agent_swap", { from: acct.address, sell: "XRP", amount: "8", buy: AGT });
ok(a1.success && a1.changes.some((x) => x.includes("AGT")), `agent swapped 8 XRP autonomously: ${a1.changes.join(", ")}`);
await refused(call("xrpl_agent_swap", { from: acct.address, sell: "XRP", amount: "12", buy: AGT }), "12 XRP (per-tx limit 10)");
const a2 = await call("xrpl_agent_swap", { from: acct.address, sell: "XRP", amount: "9", buy: AGT });
ok(a2.success, "second swap 9 XRP");
await refused(call("xrpl_agent_swap", { from: acct.address, sell: "XRP", amount: "9", buy: AGT }), "third 9 XRP (24h limit 25, 17 used)");
await refused(call("xrpl_agent_swap", { from: acct.address, sell: AGT, amount: "10", buy: "XRP" }), "selling AGT (not in policy)");
await refused(call("xrpl_agent_swap", { from: acct.address, sell: "XRP", amount: "1", buy: AGT, slippage_pct: 9 }), "slippage over 5%");
const st = await call("xrpl_agent_account_status", { address: acct.address });
ok(st.spentLast24h.XRP === 17, `spend log counts sells: ${st.spentLast24h.XRP} XRP today`);

console.log("ALL DEX/AMM MCP CHECKS PASSED");
await mcp.close(); await ledger.close(); process.exit(0);
