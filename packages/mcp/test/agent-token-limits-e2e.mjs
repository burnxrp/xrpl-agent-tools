// Token limits on agent accounts, end to end on public Testnet: owner-signed token limits, policy-gated trustline,
// autonomous token payments + token sells counted against the same per-token 24 h limit. Uses a long (hex-coded) token name.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "xrpl";
import { signPolicy, assetKey, currencyCode } from "@xrpl-agent/core";

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const refused = async (p, m) => { try { await p; } catch (e) { return ok(true, `${m} → ${e.message.replace(/^Error: /, "").slice(0, 90)}`); } ok(false, m + " should be refused"); };
const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: mkdtempSync(join(tmpdir(), "xrpl-agent-tok-")), XRPL_AGENT_UI_PORT: "7484" } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text;
  if (r.isError) throw new Error(t); return JSON.parse(t); };

const xc = new Client("wss://s.altnet.rippletest.net:51233"); await xc.connect();
const [{ wallet: owner }, { wallet: issuer }, { wallet: merchant }] = await Promise.all([1, 2, 3].map(() => xc.fundWallet()));
const raw = (w, tx) => xc.submitAndWait(tx, { wallet: w, autofill: true });
const NAME = "AGENTTOKEN", CODE = currencyCode(NAME), TOK = { currency: NAME, issuer: issuer.classicAddress }, KEY = assetKey(TOK);
await raw(issuer, { TransactionType: "AccountSet", Account: issuer.classicAddress, SetFlag: 8 });
await raw(merchant, { TransactionType: "TrustSet", Account: merchant.classicAddress, LimitAmount: { currency: CODE, issuer: issuer.classicAddress, value: "1000000" } });

const ni = await call("xrpl_network_info");
const base = ni.console.split("/#/")[0], token = new URL(ni.console.replace("#/", "")).searchParams.get("token");
const setPolicy = async (A, policy) => { const r = await fetch(`${base}/api/agents/${A}/policy`, { method: "POST",
  headers: { "Content-Type": "application/json", "X-Agent-Console-Token": token }, body: JSON.stringify({ policy, ...signPolicy(owner.seed, A, policy) }) });
  if (!r.ok) throw new Error((await r.json()).error); return r.json(); };

console.log(`1) agent account; token ${NAME} (ledger code ${CODE.slice(0, 12)}…)`);
const acct = await call("xrpl_agent_account_create", { owner: owner.classicAddress, label: "token-bot", fund_from_faucet: true });
const A = acct.address;
await refused(call("xrpl_agent_trustline", { from: A, ...TOK }), "trustline before the owner allows the token");

console.log("2) owner signs token limits");
const p0 = (await call("xrpl_agent_account_status", { address: A })).policy;
await refused(setPolicy(A, { ...p0, tokens: { [KEY]: { perTx: "90", daily: "80" } }, version: 2 }), "per-tx above daily");
await refused(setPolicy(A, { ...p0, tokens: { [`${NAME}:${issuer.classicAddress}`]: { perTx: "50", daily: "80" } }, version: 2 }), "non-canonical token key (raw long name)");
await refused(setPolicy(A, { ...p0, tokens: { [KEY]: { perTx: "-5", daily: "80" } }, version: 2 }), "negative limit");
await setPolicy(A, { ...p0, tokens: { [KEY]: { perTx: "50", daily: "80" } }, version: 2 });
ok(true, `token limits signed: ${NAME} 50/payment, 80/24 h`);

console.log("3) policy-gated trustline + funding");
const tl = await call("xrpl_agent_trustline", { from: A, ...TOK });
ok(tl.success, `agent opened its own trustline: ${tl.result}`);
await raw(issuer, { TransactionType: "Payment", Account: issuer.classicAddress, Destination: A, Amount: { currency: CODE, issuer: issuer.classicAddress, value: "200" } });
await raw(issuer, { TransactionType: "AMMCreate", Account: issuer.classicAddress, Amount: "20000000", Amount2: { currency: CODE, issuer: issuer.classicAddress, value: "200" }, TradingFee: 300 });

console.log("4) autonomous token spending within the limits");
const pay = (amount) => call("xrpl_agent_pay", { from: A, destination: merchant.classicAddress, amount, asset: TOK });
const r1 = await pay("40"); ok(r1.success && r1.delivered === `40 ${NAME}`, `paid 40 ${NAME}: ${r1.delivered}`);
await refused(pay("60"), "60 (per-payment 50)");
const r2 = await pay("30"); ok(r2.success, "paid 30 more (70 of 80 today)");
await refused(call("xrpl_agent_swap", { from: A, sell: TOK, amount: "15", buy: "XRP" }), "selling 15 (would make 85 of 80)");
const sw = await call("xrpl_agent_swap", { from: A, sell: TOK, amount: "10", buy: "XRP" });
ok(sw.success, `sold 10 ${NAME} → ${sw.changes.join(", ")} (80 of 80)`);
await refused(pay("1"), "1 more (24 h limit reached)");
const st = await call("xrpl_agent_account_status", { address: A });
ok(st.spentLast24h[KEY] === 80, `status: ${st.spentLast24h[KEY]} ${NAME} spent today`);
await raw(owner, { TransactionType: "TrustSet", Account: owner.classicAddress, LimitAmount: { currency: CODE, issuer: issuer.classicAddress, value: "1000000" } });
const back = await call("xrpl_agent_pay", { from: A, destination: owner.classicAddress, amount: "60", asset: TOK });
ok(back.success, `returned 60 ${NAME} to the owner after the limit was reached (returns are never limited): ${back.result}`);

console.log("ALL TOKEN-LIMIT CHECKS PASSED");
await mcp.close(); await xc.disconnect(); process.exit(0);
