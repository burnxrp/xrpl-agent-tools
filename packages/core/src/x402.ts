// x402 v2 on the XRP Ledger — the `exact` scheme (x402-foundation specs/schemes/exact/scheme_exact_xrpl.md).
// A paid HTTP resource answers 402 with PAYMENT-REQUIRED; the buyer signs an exact XRPL Payment (never partial,
// bound to the invoice via InvoiceID) and retries with PAYMENT-SIGNATURE; the seller's facilitator verifies every MUST
// rule, settles on the ledger and returns PAYMENT-RESPONSE. Everything here runs against public XRPL nodes — the
// facilitator is ours (self-hosted), not a central processor.
// Supported: assetTransferMethod "sequence" (the spec default) and the default "authorization" payment flow.
import { decode, validate, verifySignature, hashes, xrpToDrops, dropsToXrp, isValidClassicAddress, type Payment } from "xrpl";
import { deriveAddress } from "ripple-keypairs";
import type { Ledger } from "./ledger.js";
import type { NetworkId } from "./networks.js";
import { preparePayment, currencyCode, type Asset } from "./tools/payment.js";
import { submitSigned, type LedgerProof } from "./tools/tx.js";
import type { Prepared } from "./tools/escrow.js";

export const X402_VERSION = 2;
export const HEADER_REQUIRED = "PAYMENT-REQUIRED", HEADER_SIGNATURE = "PAYMENT-SIGNATURE", HEADER_RESPONSE = "PAYMENT-RESPONSE";

export interface X402Requirements {
  scheme: "exact"; network: string; asset: string; payTo: string; amount: string; maxTimeoutSeconds: number;
  extra: { areFeesSponsored: false; assetTransferMethod?: "sequence" | "ticketSequence"; invoiceId?: string;
           destinationTag?: number; issuer?: string; paymentFlow?: string; [k: string]: unknown };
}
export interface X402ResourceInfo { url: string; description?: string; mimeType?: string; serviceName?: string }
export interface X402PaymentRequired { x402Version: 2; error?: string; resource: X402ResourceInfo; accepts: X402Requirements[]; extensions?: Record<string, unknown> }
export interface X402PaymentPayload { x402Version: 2; resource?: X402ResourceInfo; accepted: X402Requirements; payload: { signedTxBlob: string }; extensions?: Record<string, unknown> }
export interface X402VerifyResponse { isValid: boolean; invalidReason?: string; payer?: string }
export interface X402SettleResponse { success: boolean; errorReason?: string; payer?: string; transaction: string; network: string; amount?: string }

const NETWORK_IDS: Record<NetworkId, number> = { mainnet: 0, testnet: 1, devnet: 2 };
/** CAIP-2 id for an XRPL network: xrpl:0 mainnet, xrpl:1 testnet, xrpl:2 devnet. */
export const caip2 = (n: NetworkId): string => `xrpl:${NETWORK_IDS[n]}`;

// ── encoding ─────────────────────────────────────────────────────────────────
export function b64json(v: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64json<T = any>(s: string): T {
  const bin = atob(s.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
/** InvoiceID committed in the transaction: SHA-256(invoiceId), 64 hex chars (Web Crypto: Node 19+ and browsers). */
export async function invoiceHash(invoiceId: string): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(invoiceId)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// ── exact decimal arithmetic (no binary floating point for token amounts) ──────
function dec(s: string): { i: string; f: string } {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(s).trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  let digits = m[1] + (m[2] ?? ""), point = m[1].length + Number(m[3] ?? 0);
  if (point < 0) { digits = "0".repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits = digits.padEnd(point, "0");
  return { i: digits.slice(0, point).replace(/^0+/, "") || "0", f: digits.slice(point).replace(/0+$/, "") };
}
/** -1 / 0 / 1 */
export function cmpDecimal(a: string, b: string): number {
  const x = dec(a), y = dec(b);
  if (x.i.length !== y.i.length) return x.i.length < y.i.length ? -1 : 1;
  if (x.i !== y.i) return x.i < y.i ? -1 : 1;
  const n = Math.max(x.f.length, y.f.length), xf = x.f.padEnd(n, "0"), yf = y.f.padEnd(n, "0");
  return xf === yf ? 0 : xf < yf ? -1 : 1;
}

// ── seller: describe what to pay ──────────────────────────────────────────────
export interface RequirementInput {
  network: NetworkId; payTo: string; amount: string /* human units: "0.25" XRP or "10.5" tokens */; asset: Asset;
  invoiceId?: string; destinationTag?: number; maxTimeoutSeconds?: number;
}
export function x402Requirement(i: RequirementInput): X402Requirements {
  if (!isValidClassicAddress(i.payTo)) throw new Error("payTo must be a classic XRPL address");
  if (!/^\d+(\.\d+)?$/.test(i.amount) || cmpDecimal(i.amount, "0") <= 0) throw new Error("amount must be a positive decimal");
  const xrp = i.asset === "XRP";
  return {
    scheme: "exact", network: caip2(i.network), payTo: i.payTo, maxTimeoutSeconds: i.maxTimeoutSeconds ?? 300,
    asset: xrp ? "XRP" : currencyCode((i.asset as { currency: string }).currency),
    amount: xrp ? xrpToDrops(i.amount) : i.amount,
    extra: { areFeesSponsored: false, assetTransferMethod: "sequence",
             ...(xrp ? {} : { issuer: (i.asset as { issuer: string }).issuer }),
             ...(i.invoiceId !== undefined ? { invoiceId: i.invoiceId } : {}),
             ...(i.destinationTag !== undefined ? { destinationTag: i.destinationTag } : {}) },
  };
}
export const requirementAsset = (r: X402Requirements): Asset => (r.asset === "XRP" ? "XRP" : { currency: r.asset, issuer: String(r.extra.issuer) });
/** The amount in human units ("0.25" XRP, "10.5" tokens). */
export const requirementValue = (r: X402Requirements): string => (r.asset === "XRP" ? String(dropsToXrp(r.amount)) : r.amount);

// ── buyer ─────────────────────────────────────────────────────────────────────
/** The first `accepts` entry this client can pay on `network`, or an error listing why none fit. */
export function selectRequirement(pr: X402PaymentRequired, network: NetworkId): X402Requirements {
  const why: string[] = [];
  for (const r of pr.accepts ?? []) {
    const e = r?.extra ?? ({} as X402Requirements["extra"]);
    if (r?.scheme !== "exact") { why.push(`${r?.scheme}: unsupported scheme`); continue; }
    if (r.network !== caip2(network)) { why.push(`${r.network}: not ${caip2(network)}`); continue; }
    if (e.areFeesSponsored !== false) { why.push("areFeesSponsored must be false"); continue; }
    if (e.assetTransferMethod && e.assetTransferMethod !== "sequence") { why.push(`${e.assetTransferMethod}: unsupported transfer method`); continue; }
    if (e.paymentFlow && e.paymentFlow !== "authorization") { why.push(`${e.paymentFlow}: unsupported payment flow`); continue; }
    if (!isValidClassicAddress(r.payTo)) { why.push("invalid payTo"); continue; }
    if (r.asset === "XRP" ? !/^\d+$/.test(r.amount) || r.amount === "0"
        : !(isValidClassicAddress(String(e.issuer)) && /^\d+(\.\d+)?$/.test(r.amount) && cmpDecimal(r.amount, "0") > 0)) { why.push("invalid amount/asset"); continue; }
    return r;
  }
  throw new Error(`no payable x402 option (${why.join("; ") || "empty accepts"})`);
}

/** Build the exact Payment for a requirement (autofilled, unsigned). */
export async function prepareX402Payment(ledger: Ledger, account: string, r: X402Requirements): Promise<Prepared<Payment>> {
  const p = await preparePayment(ledger, { account, destination: r.payTo, amount: requirementValue(r), asset: requirementAsset(r),
                                           destinationTag: r.extra.destinationTag });
  const tx: any = { ...p.tx };
  if (r.asset !== "XRP" && !tx.SendMax) tx.SendMax = { ...tx.Amount };          // required for IOUs (same currency/issuer)
  if (r.extra.invoiceId !== undefined) tx.InvoiceID = await invoiceHash(String(r.extra.invoiceId));
  const validated = Number((await ledger.request<any>({ command: "ledger", ledger_index: "validated" })).ledger_index);
  tx.LastLedgerSequence = Math.min(Number(tx.LastLedgerSequence), validated + Math.ceil(r.maxTimeoutSeconds / 5) + 2);
  validate(tx);
  const amt = typeof tx.Amount === "string" ? tx.Amount : tx.Amount.value;
  if (r.asset === "XRP" ? amt !== r.amount : cmpDecimal(amt, r.amount) !== 0) throw new Error("internal: amount does not match the requirement");
  return { ...p, tx, summary: `x402: pay ${requirementValue(r)} ${r.asset === "XRP" ? "XRP" : r.asset} to ${r.payTo}`,
           details: { ...p.details, ...(r.extra.invoiceId !== undefined ? { invoice: String(r.extra.invoiceId) } : {}) } };
}

export const x402Payload = (r: X402Requirements, signedTxBlob: string, resource?: X402ResourceInfo): X402PaymentPayload =>
  ({ x402Version: 2, ...(resource ? { resource } : {}), accepted: r, payload: { signedTxBlob } });

export interface X402FetchResult {
  status: number; headers: Record<string, string>; body: string;
  paid?: { requirement: X402Requirements; txHash: string; settlement?: X402SettleResponse };
  paymentRequired?: X402PaymentRequired;     // set when payment was required but not made
}

/** fetch() that pays a 402 once via `pay` (which returns the signed blob, or throws to decline). */
export async function x402Fetch(url: string, init: RequestInit & { headers?: Record<string, string> }, opts: {
  network: NetworkId; pay?: (r: X402Requirements, pr: X402PaymentRequired) => Promise<string>; fetchImpl?: typeof fetch;
}): Promise<X402FetchResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) URLs");
  const f = opts.fetchImpl ?? fetch;
  const pack = async (res: Response) => ({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() });
  const r1 = await f(url, init);
  if (r1.status !== 402) return pack(r1);
  const first = await pack(r1);
  const h = r1.headers.get(HEADER_REQUIRED);
  let pr: X402PaymentRequired | null = null;
  try { pr = h ? fromB64json(h) : JSON.parse(first.body); } catch { /* not x402 */ }
  if (!pr || pr.x402Version !== 2 || !Array.isArray(pr.accepts)) throw new Error("402 without an x402 v2 PAYMENT-REQUIRED");
  if (!opts.pay) return { ...first, paymentRequired: pr };
  const req = selectRequirement(pr, opts.network);
  const blob = await opts.pay(req, pr);
  const r2 = await f(url, { ...init, headers: { ...(init.headers ?? {}), [HEADER_SIGNATURE]: b64json(x402Payload(req, blob, pr.resource)) } });
  const out = await pack(r2);
  const sr = r2.headers.get(HEADER_RESPONSE);
  let settlement: X402SettleResponse | undefined;
  try { settlement = sr ? fromB64json(sr) : undefined; } catch { /* ignore */ }
  return { ...out, paid: { requirement: req, txHash: hashes.hashSignedTx(blob), settlement } };
}

// ── facilitator (self-hosted): verify + settle ────────────────────────────────
const PARTIAL = 0x00020000;

export class X402Facilitator {
  private readonly pending = new Map<string, number>();
  /** How the last verify checked "would it succeed now": the node's `simulate`, or targeted checks (node can't simulate). */
  lastCheck: "simulate" | "targeted" | undefined;   // tx hash → LastLedgerSequence (dedup until it can't land)
  constructor(private readonly ledger: Ledger, private readonly opts: { maxFeeDrops?: number } = {}) {}

  get network(): string { return caip2(this.ledger.network); }

  async verify(p: X402PaymentPayload, req: X402Requirements): Promise<X402VerifyResponse & { tx?: Record<string, any> }> {
    const no = (invalidReason: string, payer?: string) => ({ isValid: false, invalidReason, ...(payer ? { payer } : {}) });
    // 1. envelope
    if (p?.x402Version !== 2) return no("invalid_x402_version");
    const a = p.accepted;
    if (a?.scheme !== "exact" || req.scheme !== "exact") return no("unsupported_scheme");
    if (req.network !== this.network || a.network !== req.network) return no("invalid_network");
    for (const k of ["scheme", "network", "asset", "payTo", "amount", "maxTimeoutSeconds"] as const)
      if (String(a[k]) !== String(req[k])) return no(`accepted_mismatch_${k}`);
    const ae = a.extra ?? ({} as X402Requirements["extra"]), re = req.extra ?? ({} as X402Requirements["extra"]);
    if (re.areFeesSponsored !== false || ae.areFeesSponsored !== false) return no("fees_sponsored_not_supported");
    const method = ae.assetTransferMethod ?? re.assetTransferMethod ?? "sequence";
    if (re.assetTransferMethod && method !== re.assetTransferMethod) return no("asset_transfer_method_mismatch");
    if (method !== "sequence") return no("unsupported_asset_transfer_method");
    if (req.asset !== "XRP" && ae.issuer !== re.issuer) return no("issuer_mismatch");
    if (re.invoiceId !== undefined && String(ae.invoiceId) !== String(re.invoiceId)) return no("invoice_mismatch");
    if (re.destinationTag !== undefined && Number(ae.destinationTag) !== Number(re.destinationTag)) return no("destination_tag_mismatch");
    // 2–3. decode
    const blob = p.payload?.signedTxBlob;
    if (typeof blob !== "string" || !/^[0-9A-Fa-f]+$/.test(blob)) return no("invalid_payload");
    let tx: Record<string, any>;
    try { tx = decode(blob) as Record<string, any>; } catch { return no("invalid_transaction"); }
    const payer = String(tx.Account ?? "");
    if (tx.TransactionType !== "Payment") return no("not_a_payment", payer);
    // 4. destination
    if (tx.Destination !== req.payTo) return no("destination_mismatch", payer);
    if (re.destinationTag !== undefined && Number(tx.DestinationTag) !== Number(re.destinationTag)) return no("destination_tag_mismatch", payer);
    // 5. network binding (standard networks ≤ 1024 omit NetworkID)
    if (tx.NetworkID !== undefined) return no("network_id_must_be_omitted", payer);
    // 6. amount
    if (tx.Amount !== undefined && tx.DeliverMax !== undefined) return no("both_amount_and_delivermax", payer);
    const dst = tx.DeliverMax ?? tx.Amount;
    if (dst === undefined) return no("missing_amount", payer);
    if (tx.Paths !== undefined || tx.DeliverMin !== undefined) return no("paths_or_delivermin_present", payer);
    if ((Number(tx.Flags) || 0) & PARTIAL) return no("partial_payment", payer);
    if (req.asset === "XRP") {
      if (typeof dst !== "string" || !/^\d+$/.test(dst) || BigInt(dst) !== BigInt(req.amount)) return no("amount_mismatch", payer);
      if (tx.SendMax !== undefined) return no("sendmax_present_for_xrp", payer);
    } else {
      if (typeof dst !== "object" || dst.currency?.toUpperCase() !== req.asset.toUpperCase() || dst.issuer !== re.issuer) return no("asset_mismatch", payer);
      if (cmpDecimal(dst.value, req.amount) !== 0) return no("amount_mismatch", payer);
      const sm = tx.SendMax;
      if (!sm || typeof sm !== "object" || sm.currency?.toUpperCase() !== req.asset.toUpperCase() || sm.issuer !== re.issuer) return no("sendmax_invalid", payer);
      if (cmpDecimal(sm.value, dst.value) < 0) return no("sendmax_below_amount", payer);
    }
    // 7. expiry + sequencing
    if (tx.LastLedgerSequence === undefined) return no("missing_last_ledger_sequence", payer);
    const validated = Number((await this.ledger.request<any>({ command: "ledger", ledger_index: "validated" })).ledger_index);
    if (Number(tx.LastLedgerSequence) > validated + Math.ceil(req.maxTimeoutSeconds / 5) + 2) return no("last_ledger_sequence_too_far", payer);
    if (Number(tx.LastLedgerSequence) <= validated) return no("expired", payer);
    if (tx.TicketSequence !== undefined) return no("ticket_not_allowed_for_sequence_method", payer);
    let acct: any;
    try { acct = (await this.ledger.request<any>({ command: "account_info", account: payer, ledger_index: "current" })).account_data; }
    catch { return no("payer_not_found", payer); }
    if (Number(tx.Sequence) !== Number(acct.Sequence)) return no("sequence_not_current", payer);
    // 8. invoice binding
    if (re.invoiceId !== undefined && String(tx.InvoiceID ?? "").toUpperCase() !== await invoiceHash(String(re.invoiceId))) return no("invoice_id_mismatch", payer);
    // 9. safety
    if (Number(tx.Fee) > (this.opts.maxFeeDrops ?? 1000)) return no("fee_too_high", payer);
    if (tx.Delegate !== undefined) return no("delegate_not_allowed", payer);
    if (tx.Memos !== undefined) return no("memos_not_allowed", payer);
    if (tx.Signers !== undefined) return no("multisig_not_supported", payer);
    // 10. signature (offline) — and the key must control the account (master key unless disabled, or its regular key)
    try { if (!verifySignature(blob)) return no("invalid_signature", payer); } catch { return no("invalid_signature", payer); }
    let signer = "";
    try { signer = deriveAddress(String(tx.SigningPubKey)); } catch { return no("invalid_signature", payer); }
    const masterDisabled = ((Number(acct.Flags) >>> 0) & 0x00100000) !== 0;
    if (!((signer === payer && !masterDisabled) || (acct.RegularKey && signer === acct.RegularKey))) return no("signer_not_authorized", payer);
    // 11. would it succeed now?
    const sim = await this.simulate(blob, tx, req);
    if (sim) return no(sim, payer);
    return { isValid: true, payer, tx };
  }

  /** Returns a failure reason, or undefined if the payment would currently succeed. */
  private async simulate(blob: string, tx: Record<string, any>, req: X402Requirements): Promise<string | undefined> {
    try {
      const { TxnSignature: _sig, ...unsigned } = tx;     // simulate takes an unsigned transaction
      const r = await this.ledger.request<any>({ command: "simulate", tx_json: { ...unsigned, SigningPubKey: "" } });
      this.lastCheck = "simulate";
      return r.engine_result === "tesSUCCESS" ? undefined : `simulation_failed_${r.engine_result}`;
    } catch (e: any) {
      const err = String(e?.data?.error ?? e?.message ?? e);
      if (!/unknownCmd|notImpl|unknown method/i.test(err)) return `simulation_error`;
    }
    // targeted checks when the node can't simulate
    this.lastCheck = "targeted";
    const info = async (acc: string) => {
      try { return (await this.ledger.request<any>({ command: "account_info", account: acc, ledger_index: "current" })).account_data; } catch { return null; }
    };
    const src = await info(tx.Account), dstAcct = await info(tx.Destination);
    if (!src) return "payer_not_found";
    if (!dstAcct) return "destination_not_activated";
    if (req.asset === "XRP" && BigInt(src.Balance) < BigInt(req.amount) + BigInt(tx.Fee)) return "insufficient_funds";
    return undefined;
  }

  /** Verify again, guard against duplicate settlement, submit, wait for validation. */
  async settle(p: X402PaymentPayload, req: X402Requirements): Promise<X402SettleResponse & { proof?: LedgerProof }> {
    const v = await this.verify(p, req);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, payer: v.payer, transaction: "", network: this.network };
    const blob = p.payload.signedTxBlob, hash = hashes.hashSignedTx(blob);
    // check-and-record with no await in between (single process): duplicates are refused until the tx can't land
    if (this.pending.has(hash)) return { success: false, errorReason: "duplicate_settlement", payer: v.payer, transaction: hash, network: this.network };
    this.pending.set(hash, Number(v.tx!.LastLedgerSequence));
    this.prune().catch(() => {});
    try {
      const proof = await submitSigned(this.ledger, blob);
      return proof.success
        ? { success: true, payer: v.payer, transaction: proof.hash, network: this.network, amount: req.amount, proof }
        : { success: false, errorReason: proof.result, payer: v.payer, transaction: proof.hash, network: this.network, proof };
    } catch (e) {
      return { success: false, errorReason: `settlement_failed: ${(e as Error).message}`.slice(0, 200), payer: v.payer, transaction: hash, network: this.network };
    }
  }

  private async prune() {
    const validated = Number((await this.ledger.request<any>({ command: "ledger", ledger_index: "validated" })).ledger_index);
    for (const [h, lls] of this.pending) if (lls < validated) this.pending.delete(h);
  }
}

// ── seller: gate a request (framework-agnostic) ───────────────────────────────
export type X402GateResult =
  | { paid: false; status: 402; headers: Record<string, string>; body: X402PaymentRequired }
  | { paid: true; payer: string; requirement: X402Requirements; settle: () => Promise<{ headers: Record<string, string>; settlement: X402SettleResponse }> };

/** Use per request: no/invalid payment → a 402 to send back; valid → run the resource, then call settle() (authorization flow). */
export async function x402Gate(fac: X402Facilitator, paymentSignature: string | undefined | null,
                               accepts: X402Requirements[], resource: X402ResourceInfo): Promise<X402GateResult> {
  const required = (error: string): X402GateResult => {
    const body: X402PaymentRequired = { x402Version: 2, error, resource, accepts };
    return { paid: false, status: 402, headers: { [HEADER_REQUIRED]: b64json(body), "Content-Type": "application/json" }, body };
  };
  if (!paymentSignature) return required(`${HEADER_SIGNATURE} header is required`);
  let p: X402PaymentPayload;
  try { p = fromB64json(paymentSignature); } catch { return required("invalid_payload"); }
  const req = accepts.find((r) => ["scheme", "network", "asset", "payTo", "amount", "maxTimeoutSeconds"]
    .every((k) => String((r as any)[k]) === String((p?.accepted as any)?.[k])));
  if (!req) return required("accepted_does_not_match_any_requirement");
  const v = await fac.verify(p, req);
  if (!v.isValid) return required(v.invalidReason ?? "invalid_payment");
  return { paid: true, payer: v.payer!, requirement: req, settle: async () => {
    const s = await fac.settle(p, req);
    const { proof: _proof, ...settlement } = s as X402SettleResponse & { proof?: LedgerProof };
    return { headers: { [HEADER_RESPONSE]: b64json(settlement) }, settlement };
  } };
}
