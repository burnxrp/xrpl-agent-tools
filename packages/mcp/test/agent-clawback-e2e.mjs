// Clawback through MCP on public Testnet: agent requests → issuer approves (as the console does) → adapter confirms on ledger.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, prepareEnableClawback, prepareClawback, signLocally, submitSigned } from "@xrpl-agent/core";

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: mkdtempSync(join(tmpdir(), "xrpl-agent-cb-")), XRPL_AGENT_UI_PORT: "7483" } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text;
  if (r.isError) throw new Error(t); return JSON.parse(t); };

const ledger = new Ledger({ network: "testnet" }); const c = await ledger.client();
const [issuer, holder] = await Promise.all([1, 2].map(async () => (await c.fundWallet()).wallet));
const raw = async (w, tx) => submitSigned(ledger, signLocally(w.seed, await c.autofill(tx)).txBlob);
const ni = await call("xrpl_network_info");
const base = ni.console.split("/#/")[0], token = new URL(ni.console.replace("#/", "")).searchParams.get("token");
async function issuerApproves(id, prepareFresh) {
  const proof = await submitSigned(ledger, signLocally(issuer.seed, (await prepareFresh()).tx).txBlob);
  await fetch(`${base}/api/approvals/${id}/result`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Console-Token": token }, body: JSON.stringify({ hash: proof.hash }) });
  for (let i = 0; i < 20; i++) { const s = await call("xrpl_approval_status", { approval_id: id }); if (s.status !== "pending") return s; await new Promise((r) => setTimeout(r, 1500)); }
}

console.log("1) enable (approval)");
ok((await call("xrpl_clawback_status", { issuer: issuer.classicAddress })).canEnable, "fresh issuer can enable");
const en = await call("xrpl_clawback_enable", { account: issuer.classicAddress });
ok(en.status === "awaiting_human_approval" && en.warnings.some((w) => /permanent/i.test(w)), `queued with a permanence warning: ${en.summary}`);
ok((await issuerApproves(en.approval_id, () => prepareEnableClawback(ledger, { account: issuer.classicAddress }))).status === "confirmed", "enable confirmed on ledger");

console.log("2) clawback (approval)");
await raw(holder, { TransactionType: "TrustSet", Account: holder.classicAddress, LimitAmount: { currency: "CLW", issuer: issuer.classicAddress, value: "1000" } });
await raw(issuer, { TransactionType: "Payment", Account: issuer.classicAddress, Destination: holder.classicAddress, Amount: { currency: "CLW", issuer: issuer.classicAddress, value: "50" } });
const hs = await call("xrpl_token_holders", { issuer: issuer.classicAddress });
ok(hs[0].balance === 50, `holders: ${hs[0].holder.slice(0, 8)}… ${hs[0].balance} ${hs[0].currency}`);
const req = { account: issuer.classicAddress, holder: holder.classicAddress, currency: "CLW", amount: "20" };
const cb = await call("xrpl_clawback", req);
const s = await issuerApproves(cb.approval_id, () => prepareClawback(ledger, req));
ok(s.status === "confirmed", `clawback confirmed: ${s.proof.result} ledger ${s.proof.ledgerIndex}`);
ok((await call("xrpl_token_holders", { issuer: issuer.classicAddress }))[0].balance === 30, "holder now 30 CLW");
const tooMuch = await call("xrpl_clawback", { ...req, amount: "31" }).then(() => null, (e) => e.message);
ok(!!tooMuch, `over-claw refused before any fee: ${tooMuch?.replace(/^Error: /, "").slice(0, 60)}`);
console.log("ALL CLAWBACK MCP CHECKS PASSED");
await mcp.close(); await ledger.close(); process.exit(0);
