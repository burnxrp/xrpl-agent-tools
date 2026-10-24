#!/usr/bin/env node
// XRPL Agent MCP adapter — runs LOCALLY next to the agent (stdio). It is not a payment service: it reads public
// ledger data, prepares native transactions, and turns every state-changing request into a human approval that is
// signed by the user's own wallet in the local console. It never holds or sees a seed.
//
//   XRPL_NETWORK=testnet|devnet|mainnet   (default testnet)
//   XRPL_ENDPOINTS=wss://…,wss://…        (any public nodes; default per network)
//   XRPL_AGENT_UI_PORT=7480               (local console, 127.0.0.1 only)
//   XRPL_ALLOW_MAINNET=1                  (required before mainnet actions can even be requested)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Ledger, NETWORKS, type NetworkId, getAccount, getBalances, listEscrows, verifyTx,
  prepareEscrowCreate, prepareEscrowFinish, prepareEscrowCancel, fromRippleTime,
} from "@xrpl-agent/core";
import { approvals } from "./approvals.js";
import { startConsoleServer, SESSION_TOKEN } from "./console-server.js";

const log = (...a: unknown[]) => console.error("[xrpl-agent]", ...a);   // stdout belongs to MCP
const network = (process.env.XRPL_NETWORK || "testnet") as NetworkId;
if (!NETWORKS[network]) throw new Error(`unknown XRPL_NETWORK ${network}`);
const ledger = new Ledger({ network });
const PORT = Number(process.env.XRPL_AGENT_UI_PORT || 7480);
let uiPort = 0;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] });
const reviewUrl = (id: string) => uiPort ? `http://127.0.0.1:${uiPort}/#/approve/${id}?token=${SESSION_TOKEN}` : "(console unavailable)";

function guardNetwork() {
  if (NETWORKS[network].realValue && process.env.XRPL_ALLOW_MAINNET !== "1")
    throw new Error("mainnet actions are disabled — set XRPL_ALLOW_MAINNET=1 to allow approval requests on mainnet");
}

const server = new McpServer({ name: "xrpl-agent", version: "0.1.0" });
const ADDR = z.string().describe("XRPL classic address (r…)");
const READ = { readOnlyHint: true, openWorldHint: true } as const;
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

server.registerTool("xrpl_network_info", {
  title: "XRPL network", description: "Which public XRPL network and node this adapter uses, and the local approval console URL.",
  inputSchema: {}, annotations: READ,
}, async () => {
  try { await ledger.client(); return json({ network, name: NETWORKS[network].name, endpoint: ledger.endpoint,
    endpoints: ledger.endpoints, console: uiPort ? `http://127.0.0.1:${uiPort}/#/?token=${SESSION_TOKEN}` : null }); }
  catch (e) { return fail(e); }
});

server.registerTool("xrpl_account_info", {
  title: "Account", description: "Balance, reserve, spendable XRP and key flags of an XRPL account (validated ledger).",
  inputSchema: { address: ADDR }, annotations: READ,
}, async ({ address }) => { try { return json(await getAccount(ledger, address)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_balances", {
  title: "Balances", description: "XRP and issued-token balances (trustlines) of an XRPL account.",
  inputSchema: { address: ADDR }, annotations: READ,
}, async ({ address }) => { try { return json(await getBalances(ledger, address)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_escrow_list", {
  title: "List escrows", description: "Native escrows an account owns or will receive, with whether each can be finished or cancelled right now. Use the owner + sequence to finish/cancel.",
  inputSchema: { address: ADDR }, annotations: READ,
}, async ({ address }) => { try { return json(await listEscrows(ledger, address)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_escrow_create", {
  title: "Create escrow (needs human approval)",
  description: "Request a native XRP EscrowCreate (tool xrpl.escrow.create). Validated against the live ledger, then queued for the " +
    "account owner to approve and sign in the local console — nothing is signed or sent until they do. Returns an approval_id; " +
    "poll xrpl_approval_status. Times: '+10m', '+2h', '+1d', ISO-8601, or unix seconds.",
  inputSchema: {
    account: ADDR.describe("the wallet that locks the XRP and must approve"),
    asset: z.literal("XRP").describe("v1 supports XRP"),
    amount: z.string().regex(/^\d+(\.\d{1,6})?$/).describe("XRP amount, e.g. \"5\""),
    destination: ADDR,
    release: z.object({
      type: z.literal("time"),
      finishAfter: z.union([z.string(), z.number()]).describe("releasable after this time"),
      cancelAfter: z.union([z.string(), z.number()]).optional().describe("refundable to the sender after this time (recommended)"),
    }),
    destination_tag: z.number().int().nonnegative().optional(),
    memo: z.string().max(200).optional(),
  }, annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const p = await prepareEscrowCreate(ledger, { account: a.account, destination: a.destination, amount: a.amount,
      finishAfter: a.release.finishAfter, cancelAfter: a.release.cancelAfter, destinationTag: a.destination_tag, memo: a.memo });
    // Freeze the times as absolutes so the human approves exact moments, not "+10m from whenever".
    const input = { account: a.account, destination: a.destination, amount: a.amount, destinationTag: a.destination_tag, memo: a.memo,
      finishAfter: fromRippleTime(p.tx.FinishAfter!), finishAfterRipple: p.tx.FinishAfter,
      ...(p.tx.CancelAfter ? { cancelAfter: fromRippleTime(p.tx.CancelAfter), cancelAfterRipple: p.tx.CancelAfter } : {}) };
    const ap = approvals.add({ network, intent: { tool: "escrow_create", input }, summary: p.summary, details: p.details, warnings: p.warnings });
    log("approval requested:", ap.id, p.summary);
    return json({ status: "awaiting_human_approval", approval_id: ap.id, review_url: reviewUrl(ap.id), summary: p.summary,
                  warnings: p.warnings, next: "Ask the user to open review_url and approve; then poll xrpl_approval_status." });
  } catch (e) { return fail(e); }
});

for (const kind of ["finish", "cancel"] as const) {
  server.registerTool(`xrpl_escrow_${kind}`, {
    title: `${kind === "finish" ? "Release" : "Cancel"} escrow (needs human approval)`,
    description: kind === "finish"
      ? "Request an EscrowFinish: release a time-based escrow to its destination once finishAfter has passed. Queued for the signer to approve."
      : "Request an EscrowCancel: return an expired escrow to its owner once cancelAfter has passed. Queued for the signer to approve.",
    inputSchema: { account: ADDR.describe("the wallet that signs and pays the fee"), owner: ADDR.describe("escrow creator"),
                   sequence: z.number().int().positive().describe("the EscrowCreate's sequence (from xrpl_escrow_list)") },
    annotations: ACT,
  }, async (a) => {
    try {
      guardNetwork();
      const p = kind === "finish" ? await prepareEscrowFinish(ledger, a) : await prepareEscrowCancel(ledger, a);
      const ap = approvals.add({ network, intent: { tool: `escrow_${kind}`, input: a }, summary: p.summary, details: p.details, warnings: p.warnings });
      return json({ status: "awaiting_human_approval", approval_id: ap.id, review_url: reviewUrl(ap.id), summary: p.summary });
    } catch (e) { return fail(e); }
  });
}

server.registerTool("xrpl_approval_status", {
  title: "Approval status", description: "Status of an approval request: pending, rejected, confirmed (with validated ledger proof) or failed.",
  inputSchema: { approval_id: z.string().regex(/^[0-9a-f]{12}$/) }, annotations: READ,
}, async ({ approval_id }) => {
  const a = approvals.get(approval_id);
  if (!a) return fail("unknown approval_id");
  return json({ approval_id, status: a.status, summary: a.summary, hash: a.hash, proof: a.proof, note: a.note,
                review_url: a.status === "pending" ? reviewUrl(a.id) : undefined });
});

server.registerTool("xrpl_tx_verify", {
  title: "Ledger proof", description: "What the validated XRPL ledger says about a transaction hash (result code, ledger index, explorer link).",
  inputSchema: { hash: z.string().regex(/^[0-9A-Fa-f]{64}$/) }, annotations: READ,
}, async ({ hash }) => { try { return json(await verifyTx(ledger, hash.toUpperCase())); } catch (e) { return fail(e); } });

async function main() {
  try { uiPort = await startConsoleServer(ledger, PORT); log(`console: http://127.0.0.1:${uiPort}/#/?token=${SESSION_TOKEN}`); }
  catch (e) { log("console server not started:", String(e)); }
  await server.connect(new StdioServerTransport());
  log(`ready on ${NETWORKS[network].name}`);
}
main().catch((e) => { log(e); process.exit(1); });
