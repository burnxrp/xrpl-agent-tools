// Agent accounts end to end on public Testnet, driven exactly like an AI agent (MCP over stdio) + the owner.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client, Wallet } from "xrpl";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signPolicy } from "@xrpl-agent/core";

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const home = mkdtempSync(join(tmpdir(), "xrpl-agent-acct-"));
const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: home, XRPL_AGENT_UI_PORT: "7481" } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text;
  if (r.isError) throw new Error(t); return JSON.parse(t); };
const refused = async (p, m) => { try { await p; } catch (e) { return ok(true, `${m} → ${e.message.replace(/^Error: /, "").slice(0, 70)}`); } ok(false, m + " should be refused"); };

const xc = new Client("wss://s.altnet.rippletest.net:51233"); await xc.connect();
const { wallet: owner } = await xc.fundWallet(); const { wallet: merchant } = await xc.fundWallet(); const { wallet: other } = await xc.fundWallet();
const bal = async (a) => Number((await xc.request({ command: "account_info", account: a, ledger_index: "validated" })).result.account_data.Balance) / 1e6;

console.log("1) agent creates its own account for owner", owner.classicAddress);
const acct = await call("xrpl_agent_account_create", { owner: owner.classicAddress, label: "shopping-bot", fund_from_faucet: true });
const A = acct.address;
ok(/^r/.test(A) && !JSON.stringify(acct).match(/\bs[1-9A-HJ-NP-Za-km-z]{25,}/), `agent account ${A} — no key in the response`);
const keyFile = readFileSync(join(home, "agents", `${A}.json`), "utf8");
ok(!/\bs[1-9A-HJ-NP-Za-km-z]{25,}/.test(keyFile) && keyFile.includes('"enc"'), "key stored encrypted on disk (no plaintext seed)");
let st = await call("xrpl_agent_account_status", { address: A });
ok(Number(st.exposureCapXrp) > 90, `exposure cap = ledger balance: ${st.exposureCapXrp} XRP spendable`);

console.log("2) autonomous spending (no human step)");
const p1 = await call("xrpl_agent_pay", { from: A, destination: merchant.classicAddress, amount: "5", asset: "XRP", memo: "coffee" });
ok(p1.success && p1.delivered === "5 XRP", `paid 5 XRP autonomously — validated ${p1.result} (ledger ${p1.ledgerIndex})`);
await refused(call("xrpl_agent_pay", { from: A, destination: merchant.classicAddress, amount: "15", asset: "XRP" }), "15 XRP (per-payment limit 10)");

console.log("3) three simultaneous 9 XRP payments with 20 XRP left today");
const race = await Promise.allSettled([1, 2, 3].map(() => call("xrpl_agent_pay", { from: A, destination: merchant.classicAddress, amount: "9", asset: "XRP" })));
ok(race.filter((r) => r.status === "fulfilled").length === 2 && race.filter((r) => r.status === "rejected").length === 1,
   `exactly 2 succeeded, 1 refused: ${race.find((r) => r.status === "rejected").reason.message.replace(/^Error: /, "").slice(0, 60)}`);

console.log("4) owner-signed policy update");
const ni = await call("xrpl_network_info");
const base = ni.console.split("/#/")[0], token = new URL(ni.console.replace("#/", "")).searchParams.get("token");
const post = (path, b) => fetch(`${base}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Console-Token": token }, body: JSON.stringify(b) });
const policy = { ...st.policy, xrp: { perTx: "20", daily: "100" }, allowedDestinations: [merchant.classicAddress], version: 2 };
const agentKeySeed = Wallet.generate().seed;
await refused((async () => { const r = await post(`/agents/${A}/policy`, { policy, ...signPolicy(owner.seed, A, policy), signature: signPolicy(owner.seed, A, policy).signature.replace(/^../, "00") }); if (!r.ok) throw new Error((await r.json()).error); })(), "tampered owner signature");
await refused((async () => { const w = Wallet.fromSeed(agentKeySeed); const fake = { ...policy, owner: w.classicAddress };
  const r = await post(`/agents/${A}/policy`, { policy: fake, ...signPolicy(agentKeySeed, A, fake) }); if (!r.ok) throw new Error((await r.json()).error); })(), "policy signed by someone else (changing the owner)");
const good = await post(`/agents/${A}/policy`, { policy, ...signPolicy(owner.seed, A, policy) });
ok(good.ok, "owner-signed policy accepted: 20/payment, 100/day, merchant-only");
await refused((async () => { const r = await post(`/agents/${A}/policy`, { policy, ...signPolicy(owner.seed, A, policy) }); if (!r.ok) throw new Error((await r.json()).error); })(), "replaying the same version");
await refused(call("xrpl_agent_pay", { from: A, destination: other.classicAddress, amount: "1", asset: "XRP" }), "paying a non-allowlisted address");
const p2 = await call("xrpl_agent_pay", { from: A, destination: merchant.classicAddress, amount: "15", asset: "XRP" });
ok(p2.success, "15 XRP to the merchant now allowed (new limit 20)");
await refused(call("xrpl_agent_pay", { from: A, destination: merchant.classicAddress, amount: "1", asset: { currency: "USD", issuer: other.classicAddress } }), "a token not in the policy");

console.log("5) return to owner + the ledger cap");
const o0 = await bal(owner.classicAddress);
const r = await call("xrpl_agent_return_to_owner", { address: A });
ok(r.success, `returned ${r.delivered} to the owner (validated)`);
ok((await bal(owner.classicAddress)) > o0 + 40, "owner balance went up");
st = await call("xrpl_agent_account_status", { address: A });
ok(Number(st.exposureCapXrp) < 0.01, `agent exposure now ${st.exposureCapXrp} XRP`);
await refused(call("xrpl_agent_pay", { from: A, destination: merchant.classicAddress, amount: "5", asset: "XRP" }), "spending with an empty account (ledger cap)");
ok(st.recent.length >= 5, `local spend log has ${st.recent.length} entries`);
await xc.disconnect(); await mcp.close();
console.log("\nALL GREEN — agent accounts: autonomous, bounded by the ledger balance + owner-signed policy.");
