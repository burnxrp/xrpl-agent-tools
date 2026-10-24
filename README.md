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
| `packages/core` | **XRPL Native Tool SDK** (xrpl.js 5.3). Accounts, balances, native escrow (create / list / finish / cancel), **payments (XRP and issued tokens)**, **DEX (order book, quotes, fill-or-kill swaps, limit orders) and AMM (pool info, deposit, withdraw)**, **issuer clawback**, **x402 pay-per-request (buyer, seller and a self-hosted facilitator)**, signed submission, and ledger proof (including the **delivered** amount). "Done" means a **validated** ledger says `tesSUCCESS`. Submission alone doesn't count. |
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
| `xrpl_x402_inspect` | xrpl.x402.inspect | read: what a paid URL costs, without paying |
| `xrpl_x402_fetch` | xrpl.x402.fetch (human) | needs human approval: pays from the person's own wallet |
| `xrpl_agent_x402_fetch` | **xrpl.x402.fetch** | **autonomous**: pays an x402 resource from the agent account within the policy |
| `xrpl_agent_tickets` | xrpl.agent.tickets | list / create (max 10) / release the agent's XRPL Tickets |
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
| **Xaman** (mobile app) | on your phone. Each sign request opens in Xaman (QR code or push), and you confirm there. | Testnet · Devnet · **Mainnet** |
| **Joey** (browser extension) | in the extension. It confirms every transaction. | Testnet · Devnet · **Mainnet** |
| **GemWallet** (browser extension) | in the extension. It shows its own confirmation for every transaction. | Testnet · Devnet · **Mainnet** |
| **Crossmark** (browser extension) | in the extension. It shows its own confirmation for every transaction. | Testnet · Devnet · **Mainnet** |
| Dev wallet | this browser tab's `sessionStorage` (faucet or pasted seed) | Testnet / Devnet only, **never Mainnet** |

- **Xaman setup:**
  - create a free app at [apps.xaman.dev](https://apps.xaman.dev), and add the console's address (for example `http://127.0.0.1:7480` and `http://localhost:5179`) as an allowed origin / redirect;
  - paste its **API key** when the console asks. The key is public, not a secret, and stays in this browser's `localStorage`;
  - or start the adapter with `XRPL_XAMAN_API_KEY=…`.
- **How Xaman requests are handled:**
  - every request is created with `submit: false`, so Xaman returns the signature and the console (or the x402 adapter) submits;
  - each request is pinned with `force_network`;
  - the console refuses the result unless Xaman reports the **same NetworkID** and the same account.
- **Joey** uses its official extension SDK (`@joeywallet/wallet-sdk`, XLS-72d / Wallet Standard). Every signature passes `chain: "xrpl:N"` as a guard and `autofill: false`, so Joey signs exactly the reviewed transaction. The **Joey mobile app** connects through WalletConnect, which needs a Reown project ID; that's not built yet.
- **The console checks what the wallet signed.** It decodes the returned blob and compares it field by field with the transaction you reviewed. If the wallet changed anything (destination, amount, memos, flags), or set a fee above 10× the expected one, the console refuses to submit it. Wallets may only fill in the fee, sequence and signature.
- **Network check.** The chain *and* the network must match exactly: XRPL Mainnet ≠ Xahau Mainnet (GemWallet calls both "Mainnet"), and AMM-Devnet, sidechains and custom networks never match. The check runs when you connect **and again before every signature**, so switching the extension's network mid-session blocks signing.

### Mainnet

- **Signing:** mainnet signing works **only with Xaman, Joey, GemWallet or Crossmark**. The console never accepts a seed on Mainnet; a stored dev wallet is ignored and importing a seed is refused. Without an extension wallet, Mainnet is read-only.
- **Warnings:** the header shows **MAINNET · real funds**. Every review shows a red banner, and **Approve & sign** stays disabled until you tick that you've checked the details. Then the extension asks you to confirm again.
- **Agent requests:** they still need the adapter started with `XRPL_NETWORK=mainnet XRPL_ALLOW_MAINNET=1`. Inbox approvals are refused if their network doesn't match the console's.
- **Agent accounts on Mainnet** have no faucet. The owner funds them, and that balance is the hard cap.
- **Node failover:** if a public node rate-limits (`slowDown`, quota exhausted), the request moves to the next node in the list (xrplcluster.com → s1.ripple.com → s2.ripple.com) and that node is skipped until its back-off ends. To check reads without signing anything, run `npm run smoke:mainnet -w @xrpl-agent/core`.
- **Agent limits work with extensions too.** Extension wallets sign transactions, not arbitrary messages. So when you change an agent's limits, the extension signs an `AccountSet` that carries the policy text in a memo and can **never be applied** (`LastLedgerSequence: 1` → `tefMAX_LEDGER`). It costs no fee and doesn't touch your account. The adapter verifies the signature, the owner's master key and the exact policy. It refuses the approval if a wallet rewrote it into something that could be applied.
- **The SDKs load only when used.** `xumm` 1.8.1, `@joeywallet/wallet-sdk` 0.5.0, `@gemwallet/api` 3.8.0 and `@crossmarkio/sdk` 0.4.0 are pinned and load only when you click their button. Note that Crossmark's typings pull an old xrpl 2.x and `node-forge` into `node_modules`, but neither is part of the shipped bundle.

## x402: pay-per-request on XRPL

This implements the [x402 v2 `exact` scheme for XRPL](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_xrpl.md), the open standard for paying for an HTTP resource. The agent pays per request, with no account sign-up and no card network.

**How it works:**
1. The service answers `402` with a `PAYMENT-REQUIRED` header: price, payee, network (`xrpl:0` mainnet, `xrpl:1` Testnet, `xrpl:2` Devnet) and an invoice.
2. The buyer signs an **exact XRPL Payment**: never partial, no memos, `InvoiceID = SHA-256(invoiceId)`, an expiry within the seller's timeout, and `SendMax` covering any issuer fee for tokens.
3. The buyer retries with a `PAYMENT-SIGNATURE` header.
4. The seller's facilitator verifies, the resource runs, and the facilitator settles on the ledger and returns `PAYMENT-RESPONSE`.

**Buyer (agents):**
- `xrpl_x402_inspect` shows the price without paying.
- `xrpl_agent_x402_fetch` pays from an **agent account** only if the price fits the owner's signed policy: per-payment and 24-hour limits for that asset, plus the **allowlist, applied to the seller's `payTo`**. The agent can also set its own `max_amount`.
- The amount counts as spent **the moment it's signed**. That's conservative: it still counts if the seller never settles.
- The tool returns the resource, the seller's settlement, and **our own ledger proof** of the payment.

**Seller and facilitator (`X402Facilitator`, `x402Gate` in core):**
- It's self-hosted, so it runs against public nodes with no central processor. The seller only receives payments, so it needs no key.
- It enforces every MUST rule in the scheme: envelope, decoding, destination and tag, NetworkID omitted, exact amounts (decimal string compare, no floats), `SendMax` rules for tokens, no Paths, DeliverMin or partial-payment flag, expiry, current sequence, invoice binding, fee cap, no Delegate or Memos.
- It checks the signature offline, **and** that the signing key really controls the payer's account.
- It asks the node to **`simulate`** the payment, with targeted checks as a fallback, and **refuses duplicate settlement** of the same signed transaction until it expires.
- `examples/x402-seller.mjs` is a working paid endpoint:

  ```bash
  PAY_TO=r… PRICE_XRP=0.1 node examples/x402-seller.mjs
  ```

**From a human wallet (`xrpl_x402_fetch`):** the agent asks, and the person approves each payment in the console.
1. **The agent asks.** The adapter requests the URL. If it answers 402, the adapter queues an approval: *"Pay at most 0.3 XRP to r… for GET url"*. Free URLs are returned directly.
2. **The person clicks Review & sign.** The adapter fetches a **fresh quote**, because the seller's invoice may have expired while the request waited. It continues only if the **payee and asset are the same and the price isn't higher**. A lower price is paid at the lower amount.
3. **The wallet signs, and the console does not submit.** The dev wallet, GemWallet and Crossmark all work, and extension blobs pass the signed-blob guard.
4. **The adapter re-checks and pays.** It checks the signed payment against the quote: shape rules, sender, signature, and the approved maximum. Then it hands the payment to the seller, confirms it **on the ledger itself**, and stores the seller's response.
5. **The agent collects.** It polls `xrpl_approval_status` and gets `response` (status and body) plus the ledger proof.

**Two ways to sequence a payment** (`assetTransferMethod`):
- **`sequence`** (the default) uses the account's next sequence number. Only **one payment can be pending at a time**, so the agent holds its account lock from signing until the seller settles.
- **`ticketSequence`** uses an [XRPL Ticket](https://xrpl.org/docs/concepts/accounts/tickets), so **several payments can be pending at once**, one ticket each:
  - the agent holds its lock only while it checks the policy, picks a ticket and signs; the HTTP round trip runs in parallel;
  - pass `use_tickets: true` to prefer ticket offers. Offers that require tickets are always handled;
  - tickets are **created automatically** when none are free, at most 10 per agent account. Each locks the 0.2 XRP owner reserve and spends only the fee;
  - `xrpl_agent_tickets` lists, pre-creates or releases unused ones, which frees the reserve. Release them before **Return funds to owner** to recover that reserve.
- **The facilitator** checks `Sequence = 0` and that the ticket exists on the ledger. It refuses a second payment on a ticket that's already pending.
- **Sellers** choose with `x402Requirement({ …, assetTransferMethod })` or `METHOD=sequence|ticketSequence|both` in the example seller. The spec recommends tickets for slow resources.

**Not yet supported:**
- The `upfront`/`escrow` payment flows. We skip offers that need them.
- A Mastercard AP4M voucher signer. That plugs into the same `pay` hook once access is granted.

## Security model

- **Seeds stay with their owner.** Extension wallets keep their keys in the extension. The dev wallet keeps its Testnet/Devnet seed in that browser tab only (`sessionStorage`). The seed is never sent to any node, API, the adapter or the agent.
- **The console server is local.** It listens on 127.0.0.1 only, and every API call needs the per-session token from the review link, so other websites open in the same browser can't read or act on approvals.
- **Mainnet is opt-in.** Agent mainnet requests are refused unless the adapter has `XRPL_ALLOW_MAINNET=1`. In the console, mainnet signing works only through GemWallet or Crossmark, with an explicit real-funds acknowledgement on every review.
- **Spending limits aren't solved by delegation.** XRPL's transaction-type delegation is not an amount limit. Autonomous spending will come later through a **separately funded agent account**, where the account's own balance caps the exposure.

## Status

**x402 is complete.** Verified on public Testnet:
- **Payments:**
  - 0.25 XRP and a 2.5 USD token payment through the issuer's 1% fee;
  - each resource was delivered and settled, and the ledger copy shows the exact amount and the bound `InvoiceID`;
  - the facilitator used the node's real `simulate`.
- **Refused:**
  - an empty blob;
  - replaying a settled payment;
  - paying less;
  - a payment bound to another invoice;
  - the partial-payment flag;
  - memos;
  - a payment signed by a key that doesn't control the payer;
  - edited payment terms;
  - two simultaneous settlements of the same blob, where exactly one was delivered.
- **The agent loop:**
  - the agent checked the price, paid 0.5 XRP on its own and received the resource, the seller's settlement and its own proof;
  - over-limit prices, `max_amount` and the allowlist were all refused before anything was signed.

**Tickets**, verified on public Testnet:
- **Refused:**
  - paying a ticket-only offer with the account sequence;
  - a ticket the payer doesn't own;
  - two different payments on one ticket, where only one landed;
  - a ticket offer from a client without ticket support.
- **Parallel requests:**
  - three slow paid requests ran in parallel, every one delivered and settled with `Sequence 0` + `TicketSequence` on the ledger;
  - through MCP, 3 paid requests took **9.8 s with tickets versus 29.3 s with the sequence**.
- **Ticket upkeep:** tickets were created automatically when none were left, and the leftover ones were released.

**Human-wallet x402**, verified on public Testnet:
- **Happy path:** request → approval → fresh quote → signed → seller paid exactly → the agent got the response and proof.
- **Refused:**
  - a price increase between request and approval (a decrease was paid at the lower price);
  - a changed payee;
  - signed payments to someone else or for less;
  - an undecodable payment, a redeem without a quote, or redeeming twice;
  - the plain `/result` path;
  - `max_amount`.
- **In the real console:** the inbox → Review & sign → 0.3 XRP paid → the agent received `{"joke": …}` with a validated proof.

Tests: `npm run e2e:x402 -w @xrpl-agent/core` (both suites), `node packages/mcp/test/human-x402-e2e.mjs`, `node packages/mcp/test/agent-x402-e2e.mjs` and `node packages/mcp/test/agent-x402-tickets-e2e.mjs`.

**Mainnet signing with extension wallets is enabled.** Verified:
- the mainnet console shows only extension wallets, no seed entry, and locked actions until one is connected;
- exact network matching, including the Xahau and AMM-Devnet traps;
- the real-funds acknowledgement gates **Approve & sign**;
- mainnet reads work through the public nodes, failing over from a rate-limited xrplcluster.com to s1.ripple.com;
- **not yet done:** a real mainnet transaction through GemWallet or Crossmark, which needs the extensions and real funds.

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

**Next:**
- a hands-on mainnet test with a real extension wallet;
- a Mastercard AP4M voucher signer once early access is granted.
