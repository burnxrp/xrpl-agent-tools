// Plays the AI agent: launches the MCP adapter over stdio (like Claude Desktop does), requests an escrow,
// then waits for a HUMAN to approve it in the console and for the adapter's independent ledger verification.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client, Wallet } from "xrpl";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "xrpl-agent-"));
const transport = new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"],
  env: { ...process.env, XRPL_NETWORK: "testnet", XRPL_AGENT_HOME: home, XRPL_AGENT_UI_PORT: "7480" } });
const mcp = new McpClient({ name: "test-agent", version: "1.0.0" });
await mcp.connect(transport);
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = r.content[0].text; if (r.isError) throw new Error(t); return JSON.parse(t); };

console.log("tools:", (await mcp.listTools()).tools.map((t) => t.name).join(", "));
const net = await call("xrpl_network_info"); console.log("network:", net.name, "via", net.endpoint);

const xc = new Client("wss://s.altnet.rippletest.net:51233"); await xc.connect();
const { wallet: alice } = await xc.fundWallet(); const { wallet: bob } = await xc.fundWallet(); await xc.disconnect();
writeFileSync(process.argv[2], JSON.stringify({ seed: alice.seed, address: alice.classicAddress }), { mode: 0o600 });  // for the human step
console.log("alice", alice.classicAddress, "→ bob", bob.classicAddress);

console.log("bad request (unfunded destination) →", await call("xrpl_escrow_create", { account: alice.classicAddress, asset: "XRP", amount: "1",
  destination: Wallet.generate().classicAddress, release: { type: "time", finishAfter: "+5m" } }).catch((e) => "refused: " + e.message.slice(0, 90)));

const req = await call("xrpl_escrow_create", { account: alice.classicAddress, asset: "XRP", amount: "7", destination: bob.classicAddress,
  release: { type: "time", finishAfter: "+3m", cancelAfter: "+1d" }, memo: "agent request" });
console.log("REQUEST:", req.status, req.approval_id, "|", req.summary);
console.log("REVIEW_URL:", req.review_url);

for (let i = 0; i < 100; i++) {
  const s = await call("xrpl_approval_status", { approval_id: req.approval_id });
  if (s.status !== "pending") { console.log("FINAL:", JSON.stringify(s)); break; }
  await new Promise((r) => setTimeout(r, 3000));
}
await mcp.close();
