// x402 through MCP on public Testnet: the agent inspects a price, pays from its agent account within the owner's policy,
// gets the resource + seller settlement + its own ledger proof; over-limit / max_amount / allowlist / token cases refused.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "xrpl";
import { signPolicy } from "@xrpl-agent/core";

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const refused = async (p, m) => { try { await p; } catch (e) { return ok(true, `${m} → ${e.message.replace(/^Error: /, "").slice(0, 90)}`); } ok(false, m + " should be refused"); };
const xc = new Client("wss://s.altnet.rippletest.net:51233"); await xc.connect();
const [{ wallet: owner }, { wallet: seller }] = await Promise.all([xc.fundWallet(), xc.fundWallet()]);

const sellers = [["4031", "0.5"], ["4032", "15"]].map(([port, price]) => spawn("node", ["examples/x402-seller.mjs"],
  { env: { ...process.env, PAY_TO: seller.classicAddress, PRICE_XRP: price, PORT: port, XRPL_NETWORK: "testnet" }, stdio: ["ignore", "pipe", "inherit"] }));
await Promise.all(sellers.map((p) => new Promise((r) => p.stdout.once("data", r))));

const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: mkdtempSync(join(tmpdir(), "xrpl-agent-x402-")), XRPL_AGENT_UI_PORT: "7486" } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text;
  if (r.isError) throw new Error(t); return JSON.parse(t); };
const ni = await call("xrpl_network_info");
const base = ni.console.split("/#/")[0], token = new URL(ni.console.replace("#/", "")).searchParams.get("token");

console.log("1) agent account + price check");
const A = (await call("xrpl_agent_account_create", { owner: owner.classicAddress, label: "x402-bot", fund_from_faucet: true })).address;
const insp = await call("xrpl_x402_inspect", { url: "http://127.0.0.1:4031/joke" });
ok(insp.paid_resource && insp.options[0].payable_here && insp.options[0].human_amount === "0.5 XRP", `inspect: ${insp.options[0].human_amount} on ${insp.network}, nothing paid`);

console.log("2) autonomous paid request");
const s0 = Number((await xc.request({ command: "account_info", account: seller.classicAddress })).result.account_data.Balance);
const r = await call("xrpl_agent_x402_fetch", { from: A, url: "http://127.0.0.1:4031/joke" });
ok(r.status === 200 && JSON.parse(r.body).joke, `got the resource: ${r.body}`);
ok(r.payment.seller_settlement.success && r.payment.ledger_proof?.validated && r.payment.ledger_proof.success && r.payment.ledger_proof.delivered === "0.5 XRP",
   `seller settled + our own proof: ${r.payment.ledger_proof.delivered}, ledger ${r.payment.ledger_proof.ledgerIndex}`);
const s1 = Number((await xc.request({ command: "account_info", account: seller.classicAddress })).result.account_data.Balance);
ok(s1 - s0 === 500000, "seller received exactly 0.5 XRP");

console.log("3) refusals (nothing is signed)");
await refused(call("xrpl_agent_x402_fetch", { from: A, url: "http://127.0.0.1:4032/joke" }), "15 XRP price (per-tx limit 10)");
await refused(call("xrpl_agent_x402_fetch", { from: A, url: "http://127.0.0.1:4031/joke", max_amount: "0.1" }), "max_amount 0.1");
const p0 = (await call("xrpl_agent_account_status", { address: A })).policy;
const pol = { ...p0, allowedDestinations: [owner.classicAddress], version: 2 };
const res = await fetch(`${base}/api/agents/${A}/policy`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Console-Token": token },
  body: JSON.stringify({ policy: pol, ...signPolicy(owner.seed, A, pol) }) });
ok(res.ok, "owner restricts destinations to the owner only");
await refused(call("xrpl_agent_x402_fetch", { from: A, url: "http://127.0.0.1:4031/joke" }), "seller not on the allowlist");
const st = await call("xrpl_agent_account_status", { address: A });
ok(st.spentLast24h.XRP === 0.5 && st.recent[0].result === "x402-signed", `spend log: ${st.spentLast24h.XRP} XRP today (only the one paid request)`);

console.log("ALL X402 MCP CHECKS PASSED");
sellers.forEach((p) => p.kill()); await mcp.close(); await xc.disconnect(); process.exit(0);
