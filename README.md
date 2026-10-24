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
| `packages/core` | **XRPL Native Tool SDK** (xrpl.js 5.3). Accounts, balances, native escrow (create / list / finish / cancel), **payments (XRP and issued tokens)**, **DEX (order book, quotes, fill-or-kill swaps, limit orders) and AMM (pool info, deposit, withdraw)**, **issuer clawback**, signed submission, and ledger proof (including the **delivered** amount). "Done" means a **validated** ledger says `tesSUCCESS`. Submission alone doesn't count. |
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
| `xrpl_amm_info`, `xrpl_orderbook`, `xrpl_swap_quote`, `xrpl_offers_list` | xrpl.dex.* / xrpl.amm.info | read |
| `xrpl_swap` | **xrpl.dex.swap** | needs human approval |
| `xrpl_limit_order`, `xrpl_offer_cancel` | xrpl.dex.order / .cancel | needs human approval |
| `xrpl_amm_deposit`, `xrpl_amm_withdraw` | xrpl.amm.deposit / .withdraw | needs human approval |
| `xrpl_clawback_status`, `xrpl_token_holders` | xrpl.clawback.status / xrpl.token.holders | read |
| `xrpl_clawback_enable` | xrpl.clawback.enable | needs human approval · **permanent** |
| `xrpl_clawback` | **xrpl.clawback** | needs human approval · issuer-only, never autonomous |
| `xrpl_agent_account_create` | xrpl.agent.create | creates an agent account (key stays on this machine) |
| `xrpl_agent_accounts`, `xrpl_agent_account_status` | xrpl.agent.status | read: balance (the hard cap), policy, last 24 h |
| `xrpl_agent_pay` | **xrpl.agent.pay** | **autonomous**: no human step, within the owner's policy |
| `xrpl_agent_swap` | xrpl.agent.swap | **autonomous**: the amount sold counts against the policy; slippage ≤ 5% |
| `xrpl_agent_trustline` | xrpl.agent.trustline | **autonomous**, only for tokens in the owner's token limits |
| `xrpl_agent_return_to_owner` | xrpl.agent.return | always allowed, never limited |
| `xrpl_agent_request_funding` | xrpl.agent.fund | needs human approval (the owner tops it up) |
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

### DEX & AMM

- **Swaps are fill-or-kill sells.** You sell exactly the amount and receive at least the quoted output minus your slippage (default 1%). Otherwise the ledger returns `tecKILLED`, only the fee is spent, and no order is left resting. The ledger itself routes between the order book and the AMM pool. The quote shows both, so you can see which is better.
- **Limit orders** rest on the book until filled or cancelled. `xrpl_offers_list` and `xrpl_offer_cancel` manage them.
- **Liquidity is two-sided only.** A deposit adds `amount1` plus the matching amount of the other asset at the pool's current ratio. Withdrawals are proportional (an LP amount, or everything). Single-sided deposits and withdrawals are refused in the intent check, because they behave like a swap at the pool's price.
- **The proof shows balance changes.** For trades, the validated proof lists exactly what moved in your account, for example `-5 XRP`, `+45.2 AGT`.
- **If the pool moves after approval:** a deposit that would now need more of the second asset than the agent's request stated is refused. The agent must ask again.

### Issuer clawback

An issuer can take its tokens back from a holder, for example after fraud, a mistaken send, or a compliance order. It's the XRPL's native XLS-39 feature:

- **It must be enabled before issuing.** `AllowTrustLineClawback` can only be set while the issuer account owns nothing on the ledger: no trustlines, offers or escrows. **It can never be turned off.** Holders can see the flag on the issuer before they trust the token. `xrpl_clawback_status` tells you whether it's enabled, or exactly why it can't be.
- **Clawbacks are exact.** You name the holder, token and amount. A request for more than the holder has is refused before any fee is spent, and the intent check verifies the holder, token and amount on the ledger.
- **It's always a human decision.** Agents can only *request* a clawback, and the issuer approves it in the console, which lists every holder with a **Claw back** button. Agent accounts can't claw back.
- Clawing back from AMM pools (`AMMClawback`) and from MPTs isn't covered yet.

### How an approval works

1. **The agent asks.** It calls `xrpl_escrow_create`. The adapter checks the request against the live ledger, so things like an unactivated destination, a bad time window or a missing destination tag are refused right away and no fee is wasted. It then returns an `approval_id` and a `review_url`.
2. **The human reviews.** The `review_url` opens the console on **127.0.0.1** with a per-session token. The person sees the summary, the details, any warnings, and the exact transaction.
3. **The wallet signs in the browser**, and the transaction goes **straight to a public XRPL node**.
4. **The adapter checks independently.** It looks up the hash on the ledger and confirms the transaction is validated and matches the approved request **exactly**: same sender, destination, amount and times. A mismatch is marked `failed`.
5. **The agent gets the proof.** It polls `xrpl_approval_status` and receives `confirmed` with the validated ledger proof.

## Agent accounts (autonomous spending)

An agent account is a **separate XRPL account that the owner funds**. The agent can spend from it **without asking**, and three layers keep that bounded:

| Layer | Enforced by |
|---|---|
| **Hard cap: the agent can never spend more than you fund it with** | **The XRP Ledger.** It's simply the account's balance. |
| **Spending rules:** a per-payment limit, a 24-hour limit, allowed destinations, allowed tokens. Defaults: 10 XRP, 25 XRP/day, any destination, no tokens. | The local adapter, as defence in depth. Spends are processed one at a time, so simultaneous payments can't race past a limit. |
| **Only the owner can change the rules** | Every policy change must be **signed by the owner's wallet** and carry a higher version number. A session token alone isn't enough, so an agent that learns the console link still can't raise its own limits. |

**Token limits.** An agent can spend or sell an issued token only if the owner's signed policy lists it, with its own per-payment and 24-hour limits. Payments and sells of a token count against the same daily total. In the console, **Edit limits** has a token section. You can add a token the agent already holds from a dropdown, or enter a currency code and issuer. Once a token is listed, the agent can open its own trustline for it with `xrpl_agent_trustline`. That costs the trustline reserve, never funds, and sets NoRipple.

Every policy is validated before it's accepted, in the console and again in the adapter:
- tokens are stored under one canonical key: the ledger currency code plus the issuer, so `AGENTTOKEN` and its 40-hex form are the same token;
- limits must be plain positive numbers, with the per-payment limit no higher than the 24-hour limit;
- destinations must be valid, non-duplicate addresses;
- a policy may list at most 50 tokens and 200 destinations.

The agent account's key is generated on the agent's machine and encrypted (AES-256-GCM, scrypt key) with a machine key, or with `XRPL_AGENT_PASSPHRASE` if you set one. No tool ever returns it.

Funds can always go back to the owner, with `xrpl_agent_return_to_owner` or the console's **Return funds to owner** button. The console's **Agent accounts** panel shows each account's balance (its cap), rules, spending and history, with **Fund**, **Edit limits** (signed by the owner) and **Return** buttons.

We deliberately don't use XRPL's transaction-type delegation as a spending limit, because it isn't one.

## Wallets

The console signs with whichever wallet you connect:

| Wallet | Where the key lives | Networks |
|---|---|---|
| **GemWallet** (browser extension) | in the extension. It shows its own confirmation for every transaction. | Testnet / Devnet in v1 |
| **Crossmark** (browser extension) | in the extension. It shows its own confirmation for every transaction. | Testnet / Devnet in v1 |
| Dev wallet | this browser tab's `sessionStorage` (faucet or pasted seed) | Testnet / Devnet |

- **The console checks what the extension signed.** It decodes the returned blob and compares it field by field with the transaction you reviewed. If the wallet changed anything (destination, amount, memos, flags), or set a fee above 10× the expected one, the console refuses to submit it. Wallets may only fill in the fee, sequence and signature.
- **Network check.** The extension must be on the same network as the console, or the connection is refused.
- **Agent limits work with extensions too.** Extension wallets sign transactions, not arbitrary messages. So when you change an agent's limits, the extension signs an `AccountSet` that carries the policy text in a memo and can **never be applied** (`LastLedgerSequence: 1` → `tefMAX_LEDGER`). It costs no fee and doesn't touch your account. The adapter verifies the signature, the owner's master key and the exact policy. It refuses the approval if a wallet rewrote it into something that could be applied.
- **The SDKs load only when used.** `@gemwallet/api` 3.8.0 and `@crossmarkio/sdk` 0.4.0 are pinned and load only when you click their button. Note that Crossmark's typings pull an old xrpl 2.x and `node-forge` into `node_modules`, but neither is part of the shipped bundle.

## Security model

- **Seeds stay with their owner.** Extension wallets keep their keys in the extension. The dev wallet keeps its Testnet/Devnet seed in that browser tab only (`sessionStorage`). The seed is never sent to any node, API, the adapter or the agent.
- **The console server is local.** It listens on 127.0.0.1 only, and every API call needs the per-session token from the review link, so other websites open in the same browser can't read or act on approvals.
- **Mainnet is opt-in.** Mainnet action requests are refused unless you set `XRPL_ALLOW_MAINNET=1`. The console doesn't offer mainnet signing in v1.
- **Spending limits aren't solved by delegation.** XRPL's transaction-type delegation is not an amount limit. Autonomous spending will come later through a **separately funded agent account**, where the account's own balance caps the exposure.

## Status

**Token limits are complete.** Verified on public Testnet with a long-named (hex-coded) token:
- the agent couldn't open a trustline until the owner listed the token;
- invalid policies were rejected by the adapter;
- payments within the limit went through, and over-limit payments and sells were refused;
- payments and sells counted against one 24-hour total;
- returning tokens to the owner after hitting the limit worked;
- the console's editor rejected a bad limit and saved a valid one.

Offline policy unit tests: `npm test -w @xrpl-agent/core`.

**GemWallet and Crossmark are supported.** Verified:
- the signed-blob guard rejects a changed destination, amount, memo, partial-payment flag or excessive fee, and an untouched blob submits with `tesSUCCESS`;
- a policy approval transaction verifies, a different policy, agent or signer doesn't, and a real node rejects it (`tefMAX_LEDGER`) without touching the owner's account;
- the adapter accepts extension-style approvals.

The extensions themselves still need a hands-on test in a browser that has them installed.

**Clawback is complete.** Verified on public Testnet:
- enable on a fresh issuer;
- refusals: enabling twice, enabling once trustlines exist, clawing more than the holder has, a holder without a line, an issuer without the flag;
- an exact clawback whose intent matches the ledger copy;
- the full agent request → issuer approval → adapter confirmation loop.

**DEX & AMM are complete.** Verified on public Testnet with a real token and pool:
- the quote picked the better source between the AMM and the book;
- a swap with an impossible minimum was killed with only the fee spent;
- deposit, withdraw and withdraw-all worked;
- limit orders were placed and cancelled;
- agent requests went through approval and were confirmed on the ledger;
- a mismatched transaction reported for an approval was rejected;
- autonomous agent swaps stayed within the per-tx and 24 h limits, unapproved tokens and >5% slippage were refused.

**Agent accounts are complete.** Autonomous spending is capped by the ledger balance and an owner-signed policy. It was verified on Testnet with these results:
- autonomous payments went through;
- the per-payment and 24-hour limits held, including against 3 simultaneous payments;
- a tampered signature, a forged owner and a replayed policy were all rejected;
- the allowlist and token rules held;
- returning funds to the owner worked;
- an empty account couldn't spend.

**Payments are complete**: XRP and issued tokens for agents and humans. They were verified on public Testnet, including a token with a 1% transfer fee.

**Milestone 1 is complete.** Native escrow works on public Testnet for both an agent (MCP) and a human (console), with the human approving every agent request. The independence test passes on Ripple's and XRPL Labs' public nodes.

**Next:** mainnet signing with extension wallets (decision pending), and an optional card-rails bridge (for example Mastercard Agent Pay).
