// x402 `exact` with assetTransferMethod "ticketSequence" on public Testnet: concurrent pending payments, one ticket each.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Ledger, X402Facilitator, x402Gate, x402Requirement, x402Challenge, x402Redeem, x402Payload, prepareX402Payment, selectRequirement,
  listTickets, prepareTicketCreate, prepareTicketRelease, b64json, fromB64json, signLocally, submitSigned, HEADER_REQUIRED, HEADER_SIGNATURE,
  type X402Requirements,
} from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };

async function main() {
  const ledger = new Ledger({ network: "testnet" });
  const c = await ledger.client();
  const [seller, buyer] = await Promise.all([1, 2].map(async () => (await c.fundWallet()).wallet));
  const sign = (tx: any) => signLocally(buyer.seed!, tx).txBlob;

  // ticket-only seller with a slow resource (runs between verify and settle)
  const fac = new X402Facilitator(ledger);
  const offers = new Map<string, X402Requirements[]>();
  let n = 0;
  const server = createServer(async (req, res) => {
    const sig = req.headers[HEADER_SIGNATURE.toLowerCase()] as string | undefined;
    let accepts: X402Requirements[] = [];
    if (sig) { try { accepts = offers.get(String(fromB64json(sig).accepted?.extra?.invoiceId)) ?? []; } catch { /* */ } }
    if (!accepts.length) { const id = `T-${++n}`; accepts = [x402Requirement({ network: "testnet", payTo: seller.classicAddress, amount: "0.1", asset: "XRP", invoiceId: id, maxTimeoutSeconds: 120, assetTransferMethod: "ticketSequence" })]; offers.set(id, accepts); }
    const g = await x402Gate(fac, sig, accepts, { url: `http://localhost${req.url}` });
    if (!g.paid) { res.writeHead(402, g.headers); return res.end(JSON.stringify(g.body)); }
    await new Promise((r) => setTimeout(r, 3000));
    const { headers, settlement } = await g.settle();
    res.writeHead(settlement.success ? 200 : 402, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify(settlement.success ? { ok: true } : { error: settlement.errorReason }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/r`;
  const challenge = async () => { const ch = await x402Challenge(url, {}); return { pr: ch.paymentRequired!, r: selectRequirement(ch.paymentRequired!, "testnet") }; };
  const reason = async (r: { headers: Record<string, string>; body: string }) => { const h = r.headers[HEADER_REQUIRED.toLowerCase()]; return h ? fromB64json(h).error : JSON.parse(r.body).error; };

  console.log("1) tickets");
  ok((await submitSigned(ledger, sign((await prepareTicketCreate(ledger, { account: buyer.classicAddress, count: 5 })).tx))).success, "TicketCreate ×5");
  let tickets = await listTickets(ledger, buyer.classicAddress);
  ok(tickets.length === 5, `tickets: ${tickets.join(", ")}`);

  console.log("2) the offer requires a ticket");
  const { pr, r } = await challenge();
  ok(r.extra.assetTransferMethod === "ticketSequence", "PAYMENT-REQUIRED asks for ticketSequence");
  let threw = ""; try { selectRequirement(pr, "testnet", { tickets: false }); } catch (e) { threw = (e as Error).message; }
  ok(/ticketSequence: unsupported/.test(threw), "a client without ticket support declines it");
  threw = ""; try { await prepareX402Payment(ledger, buyer.classicAddress, r); } catch (e) { threw = (e as Error).message; }
  ok(/requires a ticket/.test(threw), "the builder refuses to pay a ticket offer without a ticket");

  console.log("3) attacks");
  const withTicket = async (rq: X402Requirements, t: number) => (await prepareX402Payment(ledger, buyer.classicAddress, rq, { ticket: t })).tx as any;
  let x = await challenge();
  const seqTx = (await prepareX402Payment(ledger, buyer.classicAddress, { ...x.r, extra: { ...x.r.extra, assetTransferMethod: "sequence" } })).tx;
  ok((await reason(await x402Redeem(url, {}, { ...x.r, extra: { ...x.r.extra, assetTransferMethod: "sequence" } }, sign(seqTx), x.pr.resource)))
     === "accepted_does_not_match_any_requirement", "paying a ticket-only offer with the account sequence → refused");
  x = await challenge();
  ok((await reason(await x402Redeem(url, {}, x.r, sign({ ...(await withTicket(x.r, tickets[0])), TicketSequence: 99_999_999 }), x.pr.resource))) === "ticket_not_available",
     "a ticket the payer doesn't own → ticket_not_available");

  console.log("4) two different payments on the SAME ticket, concurrently");
  const a = await challenge(), b = await challenge();
  const [ra, rb] = await Promise.all([
    x402Redeem(url, {}, a.r, sign(await withTicket(a.r, tickets[0])), a.pr.resource),
    x402Redeem(url, {}, b.r, sign(await withTicket(b.r, tickets[0])), b.pr.resource)]);
  const oks = [ra, rb].filter((q) => q.status === 200).length, loser = [ra, rb].find((q) => q.status !== 200)!;
  ok(oks === 1, `only one landed; the other → ${await reason(loser)}`);

  console.log("5) three payments pending at once (one ticket each, slow resource)");
  tickets = await listTickets(ledger, buyer.classicAddress);
  const t0 = Date.now();
  const three = await Promise.all(tickets.slice(0, 3).map(async (t) => { const q = await challenge(); return x402Redeem(url, {}, q.r, sign(await withTicket(q.r, t)), q.pr.resource); }));
  const secs = (Date.now() - t0) / 1000;
  ok(three.every((q) => q.status === 200 && q.paid?.settlement?.success), `all three delivered + settled in ${secs.toFixed(1)}s (each resource takes 3s + settlement)`);
  ok(secs < 3 * 3 + 6, "they overlapped instead of queueing");
  const onLedger = (await ledger.request<any>({ command: "tx", transaction: three[0].paid!.txHash })).tx_json;
  ok(onLedger.Sequence === 0 && typeof onLedger.TicketSequence === "number", `on ledger: Sequence 0, TicketSequence ${onLedger.TicketSequence}`);

  console.log("6) release the leftover ticket (frees its reserve)");
  const left = await listTickets(ledger, buyer.classicAddress);
  for (const t of left) ok((await submitSigned(ledger, sign((await prepareTicketRelease(ledger, { account: buyer.classicAddress, ticket: t })).tx))).success, `released ticket ${t}`);
  ok((await listTickets(ledger, buyer.classicAddress)).length === 0, "no tickets left");

  console.log("ALL X402 TICKET CHECKS PASSED");
  server.close(); await ledger.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
