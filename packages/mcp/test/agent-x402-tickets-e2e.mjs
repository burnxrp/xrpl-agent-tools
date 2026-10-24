// x402 ticketSequence through MCP on public Testnet: the agent auto-creates tickets and runs paid requests in parallel;
// with the account sequence they queue (one pending payment at a time, as the spec asks).
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "xrpl";

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const xc = new Client("wss://s.altnet.rippletest.net:51233"); await xc.connect();
const [{ wallet: owner }, { wallet: seller }] = await Promise.all([xc.fundWallet(), xc.fundWallet()]);
const shop = spawn("node", ["examples/x402-seller.mjs"], { env: { ...process.env, PAY_TO: seller.classicAddress, PRICE_XRP: "0.1", PORT: "4041",
  METHOD: "both", WORK_MS: "3000", XRPL_NETWORK: "testnet" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => shop.stdout.once("data", r));
const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: mkdtempSync(join(tmpdir(), "xrpl-agent-tk-")), XRPL_AGENT_UI_PORT: "7487" } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text;
  if (r.isError) throw new Error(t); return JSON.parse(t); };
const A = (await call("xrpl_agent_account_create", { owner: owner.classicAddress, label: "parallel-bot", fund_from_faucet: true })).address;
const url = "http://127.0.0.1:4041/joke";
const burst = async (args) => { const t0 = Date.now(); const rs = await Promise.all([1, 2, 3].map(() => call("xrpl_agent_x402_fetch", { from: A, url, ...args }))); return { rs, secs: (Date.now() - t0) / 1000 }; };

console.log("1) three paid requests with tickets (seller offers both methods; resource takes 3s)");
ok((await call("xrpl_agent_tickets", { from: A })).tickets.length === 0, "agent starts with no tickets");
const made = await call("xrpl_agent_tickets", { from: A, create: 4 });
ok(made.created.success && made.free.length === 4, `created 4 tickets ahead of time: ${made.tickets.join(", ")}`);
const tk = await burst({ use_tickets: true });
ok(tk.rs.every((r) => r.status === 200 && r.payment.method === "ticketSequence" && r.payment.ledger_proof?.success), `all 3 paid with tickets + proven in ${tk.secs.toFixed(1)}s`);
const st = await call("xrpl_agent_tickets", { from: A });
ok(st.tickets.length === 1 && st.max === 10, `3 tickets used, ${st.tickets.length} left (max ${st.max})`);

console.log("2) the same three with the account sequence");
const sq = await burst({});
ok(sq.rs.every((r) => r.status === 200 && r.payment.method === "sequence" && r.payment.ledger_proof?.success), `all 3 paid with the sequence in ${sq.secs.toFixed(1)}s`);
ok(sq.secs > 3 * 3 && tk.secs < sq.secs, `sequence mode queued (≥ 9s); tickets ran in parallel (${tk.secs.toFixed(1)}s vs ${sq.secs.toFixed(1)}s)`);

console.log("3) release unused tickets");
const rel = await call("xrpl_agent_tickets", { from: A, release_unused: true });
ok(rel.released.length === 1 && rel.released[0].success && rel.tickets.length === 0, "released the leftover ticket; its reserve is free again");
console.log("4) tickets are created automatically when none are left");
const auto = await call("xrpl_agent_x402_fetch", { from: A, url, use_tickets: true });
ok(auto.status === 200 && auto.payment.method === "ticketSequence", "paid with a ticket the agent created on its own");

const status = await call("xrpl_agent_account_status", { address: A });
ok(Math.abs(status.spentLast24h.XRP - 0.7) < 1e-9, `spend log: ${status.spentLast24h.XRP} XRP for 7 paid requests`);

console.log("ALL X402 TICKET MCP CHECKS PASSED");
shop.kill(); await mcp.close(); await xc.disconnect(); process.exit(0);
