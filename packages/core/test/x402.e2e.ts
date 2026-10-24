// x402 v2 `exact` on public Testnet: a real local seller (our facilitator) and a real buyer, plus the attacks the
// spec's MUST rules exist for.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "xrpl";
import {
  Ledger, X402Facilitator, x402Gate, x402Requirement, x402Fetch, x402Payload, prepareX402Payment, selectRequirement,
  b64json, fromB64json, invoiceHash, cmpDecimal, signLocally, submitSigned, HEADER_REQUIRED, HEADER_SIGNATURE, type X402Requirements,
} from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };

async function main() {
  console.log("0) exact decimals");
  ok(cmpDecimal("10.50", "10.5") === 0 && cmpDecimal("1e-2", "0.01") === 0 && cmpDecimal("10.5000001", "10.5") === 1 && cmpDecimal("9.99", "10") === -1, "decimal compare (no floats)");
  ok((await invoiceHash("INV-1")).length === 64, "InvoiceID = SHA-256(invoiceId)");

  const ledger = new Ledger({ network: "testnet" });
  const c = await ledger.client();
  const [seller, buyer, issuer] = await Promise.all([1, 2, 3].map(async () => (await c.fundWallet()).wallet));
  const raw = async (w: Wallet, tx: any) => submitSigned(ledger, signLocally(w.seed!, await c.autofill(tx)).txBlob);
  console.log("setup: token USD with a 1% issuer fee");
  await raw(issuer, { TransactionType: "AccountSet", Account: issuer.classicAddress, SetFlag: 8, TransferRate: 1_010_000_000 });
  for (const h of [seller, buyer]) await raw(h, { TransactionType: "TrustSet", Account: h.classicAddress, LimitAmount: { currency: "USD", issuer: issuer.classicAddress, value: "100000" } });
  await raw(issuer, { TransactionType: "Payment", Account: issuer.classicAddress, Destination: buyer.classicAddress, Amount: { currency: "USD", issuer: issuer.classicAddress, value: "100" } });

  // ── seller: two paid endpoints, fresh invoice per request ──
  const fac = new X402Facilitator(ledger);
  let n = 0, served = 0;
  const offers = new Map<string, X402Requirements[]>();      // invoice → what we asked for
  const server = createServer(async (req, res) => {
    const priced = req.url === "/weather" ? { amount: "0.25", asset: "XRP" as const } : { amount: "2.5", asset: { currency: "USD", issuer: issuer.classicAddress } };
    const sig = req.headers[HEADER_SIGNATURE.toLowerCase()] as string | undefined;
    let accepts: X402Requirements[];
    if (sig) { try { accepts = offers.get(String(fromB64json(sig).accepted?.extra?.invoiceId)) ?? []; } catch { accepts = []; } }
    else { const inv = `INV-${++n}`; accepts = [x402Requirement({ network: "testnet", payTo: seller.classicAddress, invoiceId: inv, maxTimeoutSeconds: 120, ...priced })]; offers.set(inv, accepts); }
    const g = await x402Gate(fac, sig, accepts.length ? accepts : [x402Requirement({ network: "testnet", payTo: seller.classicAddress, invoiceId: `INV-${++n}`, ...priced })],
                             { url: `http://localhost${req.url}`, description: "test resource", mimeType: "application/json" });
    if (!g.paid) { res.writeHead(402, g.headers); return res.end(JSON.stringify(g.body)); }
    const body = JSON.stringify({ data: req.url === "/weather" ? "sunny, 21C" : "premium report", payer: g.payer });   // the resource
    const { headers, settlement } = await g.settle();
    if (!settlement.success) { res.writeHead(402, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: settlement.errorReason })); }
    served++;
    res.writeHead(200, { ...headers, "Content-Type": "application/json" }); res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log("1) the 402 challenge");
  const r402 = await fetch(`${base}/weather`);
  const pr = fromB64json(r402.headers.get(HEADER_REQUIRED)!);
  const req = selectRequirement(pr, "testnet");
  ok(r402.status === 402 && pr.x402Version === 2 && req.network === "xrpl:1" && req.amount === "250000" && req.extra.areFeesSponsored === false,
     `402 + PAYMENT-REQUIRED: ${req.amount} drops to ${req.payTo.slice(0, 8)}… on ${req.network}, invoice ${req.extra.invoiceId}`);
  let threw = ""; try { selectRequirement(pr, "mainnet"); } catch (e) { threw = (e as Error).message; }
  ok(/not xrpl:0/.test(threw), "a testnet requirement is never paid from mainnet");

  console.log("2) pay XRP through x402Fetch");
  let lastBlob = "";
  const pay = async (r: X402Requirements) => (lastBlob = signLocally(buyer.seed!, (await prepareX402Payment(ledger, buyer.classicAddress, r)).tx).txBlob);
  const got = await x402Fetch(`${base}/weather`, {}, { network: "testnet", pay });
  ok(got.status === 200 && JSON.parse(got.body).data === "sunny, 21C", `resource delivered after payment: ${got.body}`);
  const settledBlob = lastBlob;
  ok(!!got.paid?.settlement?.success && got.paid.settlement.transaction === got.paid.txHash && got.paid.settlement.payer === buyer.classicAddress,
     `PAYMENT-RESPONSE: success, tx ${got.paid!.txHash.slice(0, 12)}…, payer = buyer`);
  const onLedger = (await ledger.request<any>({ command: "tx", transaction: got.paid!.txHash })).tx_json;
  ok(onLedger.InvoiceID === await invoiceHash(String(got.paid!.requirement.extra.invoiceId)) && !onLedger.Memos && onLedger.DeliverMax === "250000",
     "on ledger: exact 0.25 XRP, InvoiceID bound, no memos");

  console.log("3) attacks");
  // build a fresh valid payment, then tamper / replay it
  const fresh = async (path: string) => { const p = fromB64json((await fetch(`${base}${path}`)).headers.get(HEADER_REQUIRED)!); return selectRequirement(p, "testnet"); };
  const send = async (path: string, payload: unknown) => fetch(`${base}${path}`, { headers: { [HEADER_SIGNATURE]: b64json(payload) } });
  const reason = async (r: Response) => { const h = r.headers.get(HEADER_REQUIRED); return h ? fromB64json(h).error : (await r.json()).error; };

  const r0 = await send("/weather", x402Payload(await fresh("/weather"), ""));
  ok(r0.status === 402 && (await reason(r0)) === "invalid_payload", "empty blob → invalid_payload");
  const r1 = await send("/weather", x402Payload(got.paid!.requirement, settledBlob));
  ok(r1.status === 402, `replaying a settled payment → ${await reason(r1)}`);

  let rq = await fresh("/weather");
  const cheap = signLocally(buyer.seed!, { ...(await prepareX402Payment(ledger, buyer.classicAddress, rq)).tx, Amount: "1000" }).txBlob;
  const r2 = await send("/weather", x402Payload(rq, cheap));
  ok(r2.status === 402 && (await reason(r2)) === "amount_mismatch", "paying less → amount_mismatch");

  rq = await fresh("/weather");
  const other = signLocally(buyer.seed!, { ...(await prepareX402Payment(ledger, buyer.classicAddress, rq)).tx, InvoiceID: await invoiceHash("INV-someone-else") }).txBlob;
  const r3 = await send("/weather", x402Payload(rq, other));
  ok((await reason(r3)) === "invoice_id_mismatch", "payment bound to a different invoice → invoice_id_mismatch");

  rq = await fresh("/weather");
  const partial = signLocally(buyer.seed!, { ...(await prepareX402Payment(ledger, buyer.classicAddress, rq)).tx, Flags: 0x00020000 }).txBlob;
  ok((await reason(await send("/weather", x402Payload(rq, partial)))) === "partial_payment", "partial-payment flag → refused");

  rq = await fresh("/weather");
  const memo = signLocally(buyer.seed!, { ...(await prepareX402Payment(ledger, buyer.classicAddress, rq)).tx, Memos: [{ Memo: { MemoData: "AA" } }] }).txBlob;
  ok((await reason(await send("/weather", x402Payload(rq, memo)))) === "memos_not_allowed", "memos → refused");

  rq = await fresh("/weather");
  const stranger = Wallet.generate();
  const forged = stranger.sign((await prepareX402Payment(ledger, buyer.classicAddress, rq)).tx as any).tx_blob;   // bypasses our own signer guard
  ok(/signer_not_authorized|invalid_signature/.test(String(await reason(await send("/weather", x402Payload(rq, forged))))), "signed by a key that doesn't control the payer → refused");

  rq = await fresh("/weather");
  const goodBlob = await pay(rq);
  ok((await reason(await send("/weather", x402Payload({ ...rq, amount: "1" }, goodBlob)))) === "accepted_does_not_match_any_requirement", "editing the accepted terms → refused");

  console.log("4) duplicate settlement (same signed blob, concurrently)");
  const [d1, d2] = await Promise.all([send("/weather", x402Payload(rq, goodBlob)), send("/weather", x402Payload(rq, goodBlob))]);
  const statuses = [d1.status, d2.status].sort();
  ok(statuses[0] === 200 && statuses[1] === 402, `one delivered, one refused (${await reason(d1.status === 402 ? d1 : d2)})`);

  console.log("5) token (IOU) with a 1% issuer fee");
  const t = await x402Fetch(`${base}/report`, {}, { network: "testnet", pay });
  const tl = (await ledger.request<any>({ command: "tx", transaction: t.paid!.txHash })).tx_json;
  ok(t.status === 200 && t.paid!.settlement!.success && tl.DeliverMax.value === "2.5" && Number(tl.SendMax.value) >= 2.525,
     `paid 2.5 USD exactly (SendMax ${tl.SendMax.value} covers the issuer fee): ${t.body}`);

  console.log(`  · would-it-succeed check used: ${fac.lastCheck} (via ${ledger.endpoint})`);
  ok(served === 3, `resources served only for valid payments (${served})`);
  console.log("ALL X402 CHECKS PASSED");
  server.close(); await ledger.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
