// Offline x402 checks (no network): exact decimals, requirements, offer selection and the payment-shape rules.
import { Wallet } from "xrpl";
import { cmpDecimal, x402Requirement, selectRequirement, x402TxProblem, invoiceHash, b64json, fromB64json, caip2 } from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };

async function main() {
  ok(cmpDecimal("10.50", "10.5") === 0 && cmpDecimal("1e-2", "0.01") === 0 && cmpDecimal("0.1", "0.10000001") === -1 && cmpDecimal("100", "99.999") === 1, "exact decimal compare");
  ok(caip2("mainnet") === "xrpl:0" && caip2("testnet") === "xrpl:1" && caip2("devnet") === "xrpl:2", "CAIP-2 network ids");
  const payTo = Wallet.generate().classicAddress, payer = Wallet.generate().classicAddress, issuer = Wallet.generate().classicAddress;
  const xrp = x402Requirement({ network: "testnet", payTo, amount: "0.25", asset: "XRP", invoiceId: "INV-1" });
  ok(xrp.amount === "250000" && xrp.asset === "XRP" && xrp.extra.areFeesSponsored === false && xrp.extra.assetTransferMethod === "sequence", "XRP requirement in drops");
  const iou = x402Requirement({ network: "testnet", payTo, amount: "10.5", asset: { currency: "USD", issuer }, assetTransferMethod: "ticketSequence" });
  ok(iou.asset === "USD" && iou.extra.issuer === issuer && iou.extra.assetTransferMethod === "ticketSequence", "IOU requirement");
  ok(fromB64json(b64json({ a: "ü✓" })).a === "ü✓", "base64 JSON round trip (UTF-8)");
  const pr = { x402Version: 2 as const, resource: { url: "https://x" }, accepts: [{ ...xrp, network: "xrpl:0" }, xrp, iou] };
  ok(selectRequirement(pr, "testnet") === xrp, "picks the offer for this network");
  ok(selectRequirement({ ...pr, accepts: [iou, xrp] }, "testnet", { prefer: "ticketSequence" }) === iou, "prefers tickets when asked");
  let threw = ""; try { selectRequirement({ ...pr, accepts: [iou] }, "testnet", { tickets: false }); } catch (e) { threw = (e as Error).message; }
  ok(/unsupported transfer method/.test(threw), "ticket-only offer refused without ticket support");

  const base = { TransactionType: "Payment", Account: payer, Destination: payTo, Amount: "250000", Fee: "12", Sequence: 5, LastLedgerSequence: 100,
                 InvoiceID: await invoiceHash("INV-1") };
  ok(await x402TxProblem(xrp, base) === undefined, "a correct payment passes");
  const bad: [Record<string, unknown>, string][] = [
    [{ Amount: "1" }, "amount_mismatch"], [{ Destination: payer }, "destination_mismatch"], [{ Flags: 0x00020000 }, "partial_payment"],
    [{ InvoiceID: await invoiceHash("INV-2") }, "invoice_id_mismatch"], [{ Memos: [] }, "memos_not_allowed"], [{ SendMax: "300000" }, "sendmax_present_for_xrp"],
    [{ NetworkID: 1 }, "network_id_must_be_omitted"], [{ TicketSequence: 7 }, "ticket_not_allowed_for_sequence_method"],
    [{ LastLedgerSequence: undefined }, "missing_last_ledger_sequence"], [{ TransactionType: "EscrowCreate" }, "not_a_payment"],
  ];
  for (const [patch, want] of bad) ok(await x402TxProblem(xrp, { ...base, ...patch }) === want, `refused: ${want}`);
  const iouTx = { TransactionType: "Payment", Account: payer, Destination: payTo, Amount: { currency: "USD", issuer, value: "10.50" },
                  SendMax: { currency: "USD", issuer, value: "10.605" }, Sequence: 0, TicketSequence: 9, LastLedgerSequence: 100, Fee: "12" };
  ok(await x402TxProblem(iou, iouTx) === undefined, "IOU payment with issuer-fee SendMax passes (10.50 == 10.5)");
  ok(await x402TxProblem(iou, { ...iouTx, SendMax: { currency: "USD", issuer, value: "10" } }) === "sendmax_below_amount", "SendMax below amount refused");
  ok(await x402TxProblem(iou, { ...iouTx, Sequence: 3 }) === "ticket_required", "ticket offer paid with a sequence refused");
  console.log("ALL X402 UNIT CHECKS PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
