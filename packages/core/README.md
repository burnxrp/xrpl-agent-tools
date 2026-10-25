# @xrpl-agent/core

The XRP Ledger toolkit behind [`@xrpl-agent/mcp`](https://www.npmjs.com/package/@xrpl-agent/mcp), for building agent and wallet apps. Built on xrpl.js, it works in Node.js and the browser, and uses public XRPL nodes with automatic failover.

```bash
npm install @xrpl-agent/core
```

```ts
import { Ledger, preparePayment, signLocally, submitSigned } from "@xrpl-agent/core";

const ledger = new Ledger({ network: "testnet" });
const p = await preparePayment(ledger, { account, destination, amount: "5", asset: "XRP" });
// show p.summary / p.details / p.warnings to a human, sign with their wallet, then:
const proof = await submitSigned(ledger, signedBlob);   // validated tesSUCCESS = done
```

**What's in it:**
- **Preparing transactions, with checks against the live ledger before anything is signed:** payments, escrow, DEX swaps, limit orders, offer cancel, AMM deposit and withdraw, clawback.
- **Signing safety:**
  - `matchesIntent` checks that what landed on the ledger is exactly what was approved;
  - `signedBlobProblem` checks that a wallet signed exactly what was reviewed;
  - agent spending policies are owner-signed (`checkSpend`, `validatePolicy`, `verifyPolicy`).
- **x402 v2 on XRPL** ([exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_xrpl.md)):
  - buyer: `x402Fetch`, `prepareX402Payment`;
  - seller and self-hosted facilitator: `x402Requirement`, `x402Gate`, `X402Facilitator`;
  - tickets for parallel payments.

Docs: **https://github.com/burnxrp/xrpl-agent-tools** · MIT
