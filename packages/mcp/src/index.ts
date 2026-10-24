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
  prepareEscrowCreate, prepareEscrowFinish, prepareEscrowCancel, fromRippleTime, preparePayment,
  getAmm, getAmmPosition, getOrderBook, quoteSwap, prepareSwap, prepareLimitOrder, listOffers, prepareOfferCancel,
  prepareAmmDeposit, prepareAmmWithdraw, type Prepared, type Intent,
  getClawbackStatus, listHolders, prepareEnableClawback, prepareClawback,
} from "@xrpl-agent/core";
import { approvals } from "./approvals.js";
import { createAgent, agentStatus, agentPay, agentSwap, agentTrustline, returnToOwner, listAgents } from "./agents.js";
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

server.registerTool("xrpl_payment_send", {
  title: "Send a payment (needs human approval)",
  description: "Request a native Payment of XRP or an issued token (tool xrpl.payment.send). Checked against the live ledger first " +
    "(activation, trustlines, balances, issuer transfer fees, destination tags) and then queued for the sender to approve and sign " +
    "in the local console. Never a partial payment: the recipient gets exactly the amount or nothing. Poll xrpl_approval_status.",
  inputSchema: {
    account: ADDR.describe("the paying wallet, which must approve"),
    destination: ADDR,
    amount: z.string().regex(/^\d+(\.\d+)?$/).describe("decimal amount, e.g. \"12.5\""),
    asset: z.union([z.literal("XRP"), z.object({ currency: z.string().min(3).max(40), issuer: ADDR })])
      .describe("\"XRP\" or { currency, issuer } for an issued token"),
    destination_tag: z.number().int().nonnegative().optional(),
    memo: z.string().max(200).optional(),
  }, annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const input = { account: a.account, destination: a.destination, amount: a.amount, asset: a.asset,
                    destinationTag: a.destination_tag, memo: a.memo };
    const p = await preparePayment(ledger, input);
    const ap = approvals.add({ network, intent: { tool: "payment", input }, summary: p.summary, details: p.details, warnings: p.warnings });
    log("approval requested:", ap.id, p.summary);
    return json({ status: "awaiting_human_approval", approval_id: ap.id, review_url: reviewUrl(ap.id), summary: p.summary,
                  warnings: p.warnings, next: "Ask the user to open review_url and approve; then poll xrpl_approval_status." });
  } catch (e) { return fail(e); }
});

// ── Agent accounts: autonomous spending from a separately funded account (ledger balance = hard cap) ──
const ASSET = z.union([z.literal("XRP"), z.object({ currency: z.string().min(3).max(40), issuer: ADDR })]);

server.registerTool("xrpl_agent_account_create", {
  title: "Create an agent account",
  description: "Create a separately funded XRPL account this agent can spend from autonomously. Its key is generated and encrypted " +
    "on this machine and never revealed. The OWNER (a human wallet) funds it and is the only one who can change its spending policy " +
    "(defaults: 10 XRP per payment, 25 XRP per 24 h, no tokens). Exposure is capped by whatever the owner funds it with. " +
    "On Testnet/Devnet, fund_from_faucet gets test XRP.",
  inputSchema: { owner: ADDR.describe("the human wallet that controls and funds this agent account"),
                 label: z.string().max(40).optional(), fund_from_faucet: z.boolean().optional() },
  annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const r = await createAgent(ledger, a.owner, a.label ?? "agent", !!a.fund_from_faucet);
    return json({ ...r, next: a.fund_from_faucet ? "Funded from the Testnet faucet." :
      "Ask the owner to fund it (xrpl_agent_request_funding), then spend with xrpl_agent_pay." });
  } catch (e) { return fail(e); }
});

server.registerTool("xrpl_agent_accounts", {
  title: "List agent accounts", description: "Agent accounts on this machine for the current network (address, owner, policy).",
  inputSchema: {}, annotations: READ,
}, async () => json(listAgents(network)));

server.registerTool("xrpl_agent_account_status", {
  title: "Agent account status",
  description: "Balance (= the hard cap on what this agent can spend), spending policy, amount spent in the last 24 hours, recent spends.",
  inputSchema: { address: ADDR }, annotations: READ,
}, async ({ address }) => { try { return json(await agentStatus(ledger, address)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_agent_pay", {
  title: "Pay from the agent account (autonomous)",
  description: "Send XRP or an issued token FROM an agent account, signed automatically — no human approval — if it fits the owner's " +
    "policy (per-payment and 24-hour limits, allowed destinations, allowed tokens) and the account's balance. Returns the validated ledger proof.",
  inputSchema: { from: ADDR.describe("the agent account"), destination: ADDR,
                 amount: z.string().regex(/^\d+(\.\d+)?$/), asset: ASSET,
                 destination_tag: z.number().int().nonnegative().optional(), memo: z.string().max(200).optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (a) => {
  try {
    guardNetwork();
    const proof = await agentPay(ledger, a.from, { destination: a.destination, amount: a.amount, asset: a.asset,
                                                    destinationTag: a.destination_tag, memo: a.memo });
    log("autonomous payment:", a.from, "→", a.destination, a.amount, proof.result);
    return json(proof);
  } catch (e) { return fail(e); }
});

server.registerTool("xrpl_agent_return_to_owner", {
  title: "Return funds to the owner",
  description: "Send XRP from an agent account back to its owner (always allowed, never limited). Default: everything spendable.",
  inputSchema: { address: ADDR, amount: z.string().regex(/^\d+(\.\d+)?$/).optional() }, annotations: ACT,
}, async (a) => { try { return json(await returnToOwner(ledger, a.address, a.amount)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_agent_request_funding", {
  title: "Ask the owner to top up (needs human approval)",
  description: "Create an approval request for the owner to send XRP to the agent account. Nothing moves until the owner approves.",
  inputSchema: { address: ADDR.describe("the agent account"), amount: z.string().regex(/^\d+(\.\d+)?$/), reason: z.string().max(200).optional() },
  annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const st = await agentStatus(ledger, a.address);
    const input = { account: st.owner, destination: a.address, amount: a.amount, asset: "XRP" as const, memo: a.reason ? `top-up: ${a.reason}` : "agent top-up" };
    const p = await preparePayment(ledger, input);
    const ap = approvals.add({ network, intent: { tool: "payment", input }, summary: `Fund agent account ${a.address}: ${a.amount} XRP`,
                               details: { ...p.details, reason: a.reason ?? "—" }, warnings: p.warnings });
    return json({ status: "awaiting_human_approval", approval_id: ap.id, review_url: reviewUrl(ap.id), summary: ap.summary });
  } catch (e) { return fail(e); }
});

// ── DEX & AMM ──────────────────────────────────────────────────────────────────
const ASSET2 = z.union([z.literal("XRP"), z.object({ currency: z.string().min(3).max(40), issuer: ADDR })])
  .describe("\"XRP\" or { currency, issuer }");
const NUM = z.string().regex(/^\d+(\.\d+)?$/);
function queue(tool: Intent["tool"], input: any, p: Prepared<any>) {
  const ap = approvals.add({ network, intent: { tool, input } as Intent, summary: p.summary, details: p.details, warnings: p.warnings });
  log("approval requested:", ap.id, p.summary);
  return json({ status: "awaiting_human_approval", approval_id: ap.id, review_url: reviewUrl(ap.id), summary: p.summary, warnings: p.warnings,
                next: "Ask the user to open review_url and approve; then poll xrpl_approval_status." });
}

server.registerTool("xrpl_amm_info", {
  title: "AMM pool", description: "An AMM pool's reserves, trading fee, spot price and LP supply — plus an account's LP position if given.",
  inputSchema: { asset1: ASSET2, asset2: ASSET2, account: ADDR.optional() }, annotations: READ,
}, async (a) => {
  try {
    const p = await getAmm(ledger, a.asset1, a.asset2);
    const { reserve: _r, ...pool } = p;
    return json({ ...pool, position: a.account ? await getAmmPosition(ledger, a.account, p) : undefined });
  } catch (e) { return fail(e); }
});

server.registerTool("xrpl_orderbook", {
  title: "Order book", description: "Best bids/asks for base/quote on the XRPL DEX (prices in quote per 1 base).",
  inputSchema: { base: ASSET2, quote: ASSET2, limit: z.number().int().min(1).max(50).optional() }, annotations: READ,
}, async (a) => { try { return json(await getOrderBook(ledger, a.base, a.quote, a.limit ?? 10)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_swap_quote", {
  title: "Swap quote", description: "Estimate what selling an amount returns, from the AMM pool and the order book (no transaction).",
  inputSchema: { sell: ASSET2, amount: NUM, buy: ASSET2 }, annotations: READ,
}, async (a) => { try { return json(await quoteSwap(ledger, a.sell, a.buy, a.amount)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_swap", {
  title: "Swap (needs human approval)",
  description: "Request a swap (tool xrpl.dex.swap): sell exactly `amount`, receive at least the quote minus slippage — Fill-or-Kill, so it " +
    "fills completely or nothing happens and no order is left resting. The ledger routes through the order book and AMM. Queued for approval.",
  inputSchema: { account: ADDR, sell: ASSET2, amount: NUM, buy: ASSET2, slippage_pct: z.number().min(0).max(20).optional() }, annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const p = await prepareSwap(ledger, { account: a.account, sell: a.sell, amount: a.amount, buy: a.buy, slippagePct: a.slippage_pct });
    return queue("swap", { account: a.account, sell: a.sell, amount: a.amount, buy: a.buy, minOut: p.minOut }, p);
  } catch (e) { return fail(e); }
});

server.registerTool("xrpl_limit_order", {
  title: "Limit order (needs human approval)",
  description: "Request a resting order: sell `sell_amount` of one asset for `buy_amount` of another. Stays on the book until filled or cancelled.",
  inputSchema: { account: ADDR, sell: ASSET2, sell_amount: NUM, buy: ASSET2, buy_amount: NUM, passive: z.boolean().optional() }, annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const input = { account: a.account, sell: a.sell, sellAmount: a.sell_amount, buy: a.buy, buyAmount: a.buy_amount, passive: a.passive };
    return queue("limit_order", input, await prepareLimitOrder(ledger, input));
  } catch (e) { return fail(e); }
});

server.registerTool("xrpl_offers_list", {
  title: "Open orders", description: "An account's resting orders on the XRPL DEX.",
  inputSchema: { account: ADDR }, annotations: READ,
}, async ({ account }) => { try { return json(await listOffers(ledger, account)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_offer_cancel", {
  title: "Cancel order (needs human approval)", description: "Request cancelling one of the account's resting orders (by sequence from xrpl_offers_list).",
  inputSchema: { account: ADDR, sequence: z.number().int().positive() }, annotations: ACT,
}, async (a) => { try { guardNetwork(); return queue("offer_cancel", a, await prepareOfferCancel(ledger, a)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_amm_deposit", {
  title: "Add liquidity (needs human approval)",
  description: "Request a two-asset AMM deposit: `amount1` of asset1 plus the matching amount of asset2 at the pool's current ratio.",
  inputSchema: { account: ADDR, asset1: ASSET2, asset2: ASSET2, amount1: NUM }, annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const p = await prepareAmmDeposit(ledger, a);
    return queue("amm_deposit", { ...a, amount2: p.amount2 }, p);
  } catch (e) { return fail(e); }
});

server.registerTool("xrpl_amm_withdraw", {
  title: "Remove liquidity (needs human approval)",
  description: "Request a proportional AMM withdrawal (both assets back): `lp_tokens`, or `all: true`.",
  inputSchema: { account: ADDR, asset1: ASSET2, asset2: ASSET2, lp_tokens: NUM.optional(), all: z.boolean().optional() }, annotations: ACT,
}, async (a) => {
  try {
    guardNetwork();
    const input = { account: a.account, asset1: a.asset1, asset2: a.asset2, lpTokens: a.lp_tokens, all: a.all };
    return queue("amm_withdraw", input, await prepareAmmWithdraw(ledger, input));
  } catch (e) { return fail(e); }
});

server.registerTool("xrpl_agent_swap", {
  title: "Swap from the agent account (autonomous)",
  description: "Fill-or-kill swap from an agent account, signed automatically if the amount sold fits the owner's policy for that asset. " +
    "Slippage is capped at 5%. Returns the validated proof with the balance changes.",
  inputSchema: { from: ADDR, sell: ASSET2, amount: NUM, buy: ASSET2, slippage_pct: z.number().min(0).max(5).optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (a) => {
  try { guardNetwork(); return json(await agentSwap(ledger, a.from, { sell: a.sell, amount: a.amount, buy: a.buy, slippagePct: a.slippage_pct })); }
  catch (e) { return fail(e); }
});

// ── Issuer clawback ─────────────────────────────────────────────────────────────
server.registerTool("xrpl_clawback_status", {
  title: "Clawback status", description: "Whether an issuer can claw back its tokens (AllowTrustLineClawback), or why it can't enable it.",
  inputSchema: { issuer: ADDR }, annotations: READ,
}, async ({ issuer }) => { try { return json(await getClawbackStatus(ledger, issuer)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_token_holders", {
  title: "Token holders", description: "Accounts holding an issuer's tokens, largest first (optionally one currency).",
  inputSchema: { issuer: ADDR, currency: z.string().min(3).max(40).optional() }, annotations: READ,
}, async (a) => { try { return json(await listHolders(ledger, a.issuer, a.currency)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_clawback_enable", {
  title: "Enable clawback (needs human approval, PERMANENT)",
  description: "Request permanently allowing an issuer to claw back its tokens. Only possible before the issuer owns anything on the " +
    "ledger (i.e. before issuing). Can never be turned off. Queued for the issuer's approval.",
  inputSchema: { account: ADDR }, annotations: ACT,
}, async (a) => { try { guardNetwork(); return queue("clawback_enable", a, await prepareEnableClawback(ledger, a)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_clawback", {
  title: "Claw back tokens (needs human approval)",
  description: "Request taking back `amount` of the issuer's token from one holder (exact — refused if they hold less). " +
    "Issuer-only; never available to agent accounts. Queued for the issuer's approval.",
  inputSchema: { account: ADDR.describe("the issuer"), holder: ADDR, currency: z.string().min(3).max(40), amount: NUM }, annotations: ACT,
}, async (a) => { try { guardNetwork(); return queue("clawback", a, await prepareClawback(ledger, a)); } catch (e) { return fail(e); } });

server.registerTool("xrpl_agent_trustline", {
  title: "Agent trustline (autonomous, policy tokens only)",
  description: "Open a trustline from an agent account so it can receive a token. Allowed only for tokens in the owner's signed " +
    "token limits; costs the trustline reserve, never funds. NoRipple is set.",
  inputSchema: { from: ADDR, currency: z.string().min(3).max(40), issuer: ADDR },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async (a) => { try { guardNetwork(); return json(await agentTrustline(ledger, a.from, { currency: a.currency, issuer: a.issuer })); } catch (e) { return fail(e); } });

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
