# XRPL Agent Tools

Ledger-native XRPL tools for **AI agents** (via MCP) and **humans** (via a wallet dashboard), both built on one
tool library. There's no proprietary backend, hosted payment service, or trusted operator. Every action runs on
public XRPL nodes, and the result is enforced by ledger consensus.

```
 AI agent ──MCP (stdio, local)──┐             ┌── Human: XRPL Agent Console (static web app)
                                ▼             ▼
                    @xrpl-agent/core — transaction construction · validation · signing interface · ledger proof
                                        │
                     public XRPL nodes (Testnet / Devnet / Mainnet) — any operator, configurable
```

## Packages

| Package | What it is |
|---|---|
| `packages/core` | **XRPL Native Tool SDK** (xrpl.js 5.3). Accounts, balances, native escrow (create / list / finish / cancel), **payments (XRP and issued tokens)**, signed submission, and ledger proof (including the **delivered** amount). "Done" means a **validated** ledger says `tesSUCCESS`. Submission alone doesn't count. |
| `packages/mcp` | **Local MCP adapter** (stdio). Read tools answer directly. Every state-changing tool creates an **approval request** that the account owner signs in the console. The adapter never holds or sees a seed. |
| `apps/console` | **XRPL Agent Console**. A static dashboard that connects straight to public XRPL nodes from the browser. Opened from an agent's review link, it also shows the agent's approval inbox. |

## Quick start

```bash
npm install
npm run build
npm run test:escrow                                              # escrow + payments runs on public Testnet
XRPL_ENDPOINTS=wss://testnet.xrpl-labs.com npm run test:escrow   # same run through a different operator
```

The console runs standalone with `npm run dev -w @xrpl-agent/console`, or you can serve `apps/console/dist` from any static host.

## Use it from an AI agent (MCP)

Add the adapter to your agent's MCP config. For example, in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xrpl": {
      "command": "node",
      "args": ["/absolute/path/to/xrpl-agent-tools/packages/mcp/dist/index.js"],
      "env": { "XRPL_NETWORK": "testnet" }
    }
  }
}
```

| Tool | Plan name | Kind |
|---|---|---|
| `xrpl_network_info` | — | read |
| `xrpl_account_info`, `xrpl_balances` | xrpl.account.* | read |
| `xrpl_escrow_list` | xrpl.escrow.list | read |
| `xrpl_escrow_create` | **xrpl.escrow.create** | needs human approval |
| `xrpl_escrow_finish`, `xrpl_escrow_cancel` | xrpl.escrow.finish / .cancel | needs human approval |
| `xrpl_payment_send` | **xrpl.payment.send** | needs human approval |
| `xrpl_approval_status` | — | read (returns the ledger proof once confirmed) |
| `xrpl_tx_verify` | xrpl.ledger.proof | read |

`xrpl_escrow_create` takes the plan's argument shape:

```json
{ "account": "r…sender", "asset": "XRP", "amount": "5", "destination": "r…recipient",
  "release": { "type": "time", "finishAfter": "+10m", "cancelAfter": "+1d" } }
```

Times can be `+90s`, `+10m`, `+2h`, `+1d`, an ISO date, or unix seconds. They're fixed to exact moments when the request is made.

`xrpl_payment_send` takes `{ "account", "destination", "amount": "12.5", "asset": "XRP" | { "currency": "USD", "issuer": "r…" } }`. Before you sign, it checks:

- **Activation:** sending XRP to a new address must cover the base reserve.
- **Trustlines:** the recipient must have a trustline for the token, with enough limit, and it must not be frozen.
- **Balances:** you must hold enough, counting the reserve.
- **Destination tags:** required tags must be present.
- **Issuer transfer fees:** these are written into `SendMax`, so the sender pays the fee and the recipient gets exactly the amount.

Payments are **never partial**. The partial-payment flag is refused when the transaction is built and again during the intent check. The proof reports the **delivered** amount from the ledger metadata.

### How an approval works

1. **The agent asks.** It calls `xrpl_escrow_create`. The adapter checks the request against the live ledger, so things like an unactivated destination, a bad time window or a missing destination tag are refused right away and no fee is wasted. It then returns an `approval_id` and a `review_url`.
2. **The human reviews.** The `review_url` opens the console on **127.0.0.1** with a per-session token. The person sees the summary, the details, any warnings, and the exact transaction.
3. **The wallet signs in the browser**, and the transaction goes **straight to a public XRPL node**.
4. **The adapter checks independently.** It looks up the hash on the ledger and confirms the transaction is validated and matches the approved request **exactly**: same sender, destination, amount and times. A mismatch is marked `failed`.
5. **The agent gets the proof.** It polls `xrpl_approval_status` and receives `confirmed` with the validated ledger proof.

## Security model

- **Seeds stay with their owner.** In v1, the console signs with a Testnet/Devnet wallet kept in that browser tab only (`sessionStorage`). The seed is never sent to any node, API, the adapter or the agent.
- **The console server is local.** It listens on 127.0.0.1 only, and every API call needs the per-session token from the review link, so other websites open in the same browser can't read or act on approvals.
- **Mainnet is opt-in.** Mainnet action requests are refused unless you set `XRPL_ALLOW_MAINNET=1`. The console doesn't offer mainnet signing in v1.
- **Spending limits aren't solved by delegation.** XRPL's transaction-type delegation is not an amount limit. Autonomous spending will come later through a **separately funded agent account**, where the account's own balance caps the exposure.

## Status

**Payments are complete**: XRP and issued tokens for agents and humans. They were verified on public Testnet, including a token with a 1% transfer fee.

**Milestone 1 is complete.** Native escrow works on public Testnet for both an agent (MCP) and a human (console), with the human approving every agent request. The independence test passes on Ripple's and XRPL Labs' public nodes.

**Next:** issuer clawback, DEX/AMM, browser-extension wallets (GemWallet / Crossmark), and agent accounts for bounded autonomous spending.
