// Minimal x402 seller on XRPL: one paid endpoint, settled by our own facilitator on public nodes.
// The seller never needs a key; it only receives. Run (after `npm run build`):
//   PAY_TO=r... PRICE_XRP=0.1 XRPL_NETWORK=testnet PORT=4021 node examples/x402-seller.mjs
// Optional: METHOD=sequence|ticketSequence|both (default sequence), WORK_MS=3000 to simulate a slow resource.
// then from your agent: xrpl_x402_inspect / xrpl_agent_x402_fetch  http://127.0.0.1:4021/joke
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Ledger, X402Facilitator, x402Gate, x402Requirement, fromB64json, HEADER_SIGNATURE } from "@xrpl-agent/core";

const network = process.env.XRPL_NETWORK || "testnet";
const payTo = process.env.PAY_TO, price = process.env.PRICE_XRP || "0.1", port = Number(process.env.PORT || 4021);
const methods = process.env.METHOD === "both" ? ["sequence", "ticketSequence"] : [process.env.METHOD || "sequence"];
const workMs = Number(process.env.WORK_MS || 0);
if (!payTo) { console.error("set PAY_TO to the XRPL address that receives payments"); process.exit(1); }
if (network === "mainnet" && process.env.XRPL_ALLOW_MAINNET !== "1") { console.error("mainnet needs XRPL_ALLOW_MAINNET=1"); process.exit(1); }

const fac = new X402Facilitator(new Ledger({ network }));
const offers = new Map();                                    // invoiceId → requirement (expires with the timeout)
const JOKES = ["I tried to catch fog. I mist.", "Ledgers never forget; they just close.", "Decimal arithmetic: no floating, only facts."];

createServer(async (req, res) => {
  if (req.url !== "/joke") { res.writeHead(404); return res.end(); }
  const sig = req.headers[HEADER_SIGNATURE.toLowerCase()];
  let accepts;
  if (sig) { try { accepts = offers.get(String(fromB64json(sig).accepted?.extra?.invoiceId)) ?? []; } catch { accepts = []; } }
  if (!accepts?.length) {
    const invoiceId = randomUUID();
    accepts = methods.map((m) => x402Requirement({ network, payTo, amount: price, asset: "XRP", invoiceId, maxTimeoutSeconds: 120, assetTransferMethod: m }));
    offers.set(invoiceId, accepts); setTimeout(() => offers.delete(invoiceId), 180_000);
  }
  const g = await x402Gate(fac, sig, accepts, { url: `http://${req.headers.host}/joke`, description: "One joke", mimeType: "application/json", serviceName: "x402 joke demo" });
  if (!g.paid) { res.writeHead(402, g.headers); return res.end(JSON.stringify(g.body)); }
  if (workMs) await new Promise((r) => setTimeout(r, workMs));               // the (slow) resource runs between verify and settle
  const { headers, settlement } = await g.settle();
  if (!settlement.success) { res.writeHead(402, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: settlement.errorReason })); }
  offers.delete(g.requirement.extra.invoiceId);
  console.log(`paid ${price} XRP by ${settlement.payer} (${g.requirement.extra.assetTransferMethod}) — tx ${settlement.transaction}`);
  res.writeHead(200, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify({ joke: JOKES[Math.floor(Math.random() * JOKES.length)] }));
}).listen(port, "127.0.0.1", () => console.log(`x402 seller on http://127.0.0.1:${port}/joke — ${price} XRP to ${payTo} (${network}, ${methods.join("+")})`));
