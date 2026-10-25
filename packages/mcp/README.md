# @xrpl-agent/mcp

Let AI agents **pay, trade and get paid on the XRP Ledger**, with you in control. This is a local [MCP](https://modelcontextprotocol.io) server for Claude and other MCP-capable agents. It talks only to public XRPL nodes: there's no custody, no middleman and no hosted backend.

## Add it to your agent

Claude Desktop (`claude_desktop_config.json`) or any MCP client:

```json
{
  "mcpServers": {
    "xrpl": {
      "command": "npx",
      "args": ["-y", "@xrpl-agent/mcp"],
      "env": { "XRPL_NETWORK": "testnet" }
    }
  }
}
```

Restart your agent, then ask things like *"what's my XRPL balance?"*, *"send 5 XRP to r…"*, *"swap 10 XRP for USD, at least 4.8"* or *"fetch this paid URL"*.

## Two ways to stay in control

- **Approve each action.** Every payment, trade, escrow or clawback becomes an approval request. You approve it in the local console (opened from the agent's review link at `http://127.0.0.1:7480`) with Xaman, Joey, GemWallet or Crossmark. Or approve it **on your phone in Xaman**: set `XRPL_XAMAN_API_KEY` and `XRPL_XAMAN_API_SECRET`, then ask the agent to *"link my phone"*. Your keys never leave your wallet.
- **Give the agent a budget.** You fund a separate agent account. It spends on its own only within limits you sign: per payment, per 24 hours, allowed recipients, allowed tokens. It can never spend more than its balance.

## What the agent can do

Payments (XRP and tokens, never partial) · native escrow · DEX swaps with a guaranteed minimum · limit orders · AMM liquidity · issuer clawback · **x402 pay-per-request** (official XRPL `exact` scheme, including tickets for parallel requests) · ledger proofs.

## Settings

| Variable | Default | |
|---|---|---|
| `XRPL_NETWORK` | `testnet` | `testnet`, `devnet` or `mainnet` |
| `XRPL_ALLOW_MAINNET` | unset | set to `1` to allow mainnet actions |
| `XRPL_ENDPOINTS` | public nodes | comma-separated `wss://` endpoints of your choice |
| `XRPL_AGENT_UI_PORT` | `7480` | local console port (127.0.0.1 only) |
| `XRPL_XAMAN_API_KEY`, `XRPL_XAMAN_API_SECRET` | unset | phone approvals through your own Xaman app ([apps.xaman.dev](https://apps.xaman.dev)) |
| `XRPL_AGENT_HOME` | `~/.xrpl-agent` | approvals, agent accounts (encrypted keys) and phone link |

Full documentation, the security model and the tests: **https://github.com/burnxrp/xrpl-agent-tools**. MIT licensed.
