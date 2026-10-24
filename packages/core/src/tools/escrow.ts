// Native XRP escrow: EscrowCreate / EscrowFinish / EscrowCancel. These functions only PREPARE transactions
// (autofilled + validated). Signing happens with the user's wallet; submission + validation in tx.ts.
import { validate, xrpToDrops, dropsToXrp, convertStringToHex, type EscrowCreate, type EscrowFinish, type EscrowCancel } from "xrpl";
import type { Ledger } from "../ledger.js";
import { assertAddress, getAccount } from "./account.js";
import { parseWhen, toRippleTime, fromRippleTime } from "../time.js";

export interface Prepared<T> {
  network: string;
  tx: T;                     // autofilled, unsigned, ready for the wallet
  summary: string;           // one-line human description for the approval screen
  details: Record<string, string>;
  warnings: string[];
}

export interface EscrowCreateInput {
  account: string;           // who locks the XRP (signs)
  destination: string;
  amount: string;            // XRP, e.g. "5"
  finishAfter?: string | number;   // "+10m" | ISO | unix seconds — can be released after this
  cancelAfter?: string | number;   // can be cancelled (returned to sender) after this
  destinationTag?: number;
  memo?: string;
}

async function finalize<T extends Record<string, any>>(ledger: Ledger, tx: T): Promise<T> {
  const c = await ledger.client();
  const filled = (await c.autofill(tx as any)) as unknown as T;
  validate(filled as any);   // throws on malformed transactions
  return filled;
}

export async function prepareEscrowCreate(ledger: Ledger, input: EscrowCreateInput): Promise<Prepared<EscrowCreate>> {
  assertAddress(input.account, "account");
  assertAddress(input.destination, "destination");
  const amount = Number(input.amount);
  if (!(amount > 0)) throw new Error("amount must be a positive number of XRP");
  if (input.finishAfter === undefined) throw new Error("finishAfter is required (a time-based release) in v1");
  const now = new Date();
  const finish = parseWhen(input.finishAfter, now);
  if (finish.getTime() <= now.getTime()) throw new Error("finishAfter must be in the future");
  const cancel = input.cancelAfter !== undefined ? parseWhen(input.cancelAfter, now) : undefined;
  if (cancel && cancel.getTime() <= finish.getTime()) throw new Error("cancelAfter must be later than finishAfter");

  const warnings: string[] = [];
  const [src, dst] = await Promise.all([getAccount(ledger, input.account), getAccount(ledger, input.destination)]);
  if (!src.exists) throw new Error(`account ${input.account} is not activated on ${ledger.network}`);
  if (!dst.exists) throw new Error(`destination ${input.destination} is not activated — the ledger would reject this (tecNO_DST)`);
  if (Number(src.spendableXrp) < amount + 0.2) warnings.push(`spendable balance is ${src.spendableXrp} XRP — this escrow also locks an owner reserve`);
  if (dst.flags.requireDestTag && input.destinationTag === undefined) throw new Error("destination requires a destination tag");
  if (!cancel) warnings.push("no cancelAfter: if nobody finishes it, the XRP stays locked forever");

  const tx: EscrowCreate = {
    TransactionType: "EscrowCreate", Account: input.account, Destination: input.destination,
    Amount: xrpToDrops(input.amount), FinishAfter: toRippleTime(finish),
    ...(cancel ? { CancelAfter: toRippleTime(cancel) } : {}),
    ...(input.destinationTag !== undefined ? { DestinationTag: input.destinationTag } : {}),
    ...(input.memo ? { Memos: [{ Memo: { MemoData: convertStringToHex(input.memo) } }] } : {}),
  };
  const filled = await finalize(ledger, tx);
  return {
    network: ledger.network, tx: filled, warnings,
    summary: `Lock ${input.amount} XRP for ${input.destination}, releasable after ${finish.toISOString()}` +
             (cancel ? `, refundable after ${cancel.toISOString()}` : ""),
    details: { from: input.account, to: input.destination, amount: `${input.amount} XRP`,
               finishAfter: finish.toISOString(), cancelAfter: cancel ? cancel.toISOString() : "never",
               fee: `${dropsToXrp(filled.Fee!)} XRP`, sequence: String(filled.Sequence) },
  };
}

export interface EscrowRef { owner: string; sequence: number }

export interface EscrowEntry extends EscrowRef {
  destination: string;
  amountXrp: string;
  finishAfter?: string;
  cancelAfter?: string;
  hasCondition: boolean;
  canFinishNow: boolean;
  canCancelNow: boolean;
  createdTx: string;
}

/** Escrows the address owns or will receive, read from validated ledger state. */
export async function listEscrows(ledger: Ledger, address: string): Promise<EscrowEntry[]> {
  assertAddress(address);
  const r = await ledger.request<any>({ command: "account_objects", account: address, type: "escrow", ledger_index: "validated", limit: 200 });
  const now = await ledger.validatedCloseTime();
  const out: EscrowEntry[] = [];
  for (const e of r.account_objects ?? []) {
    if (typeof e.Amount !== "string") continue;   // XRP escrows only in v1
    const created = await ledger.request<any>({ command: "tx", transaction: e.PreviousTxnID });
    const ct = created.tx_json ?? created;
    const seq = ct.TransactionType === "EscrowCreate" ? (ct.Sequence || ct.TicketSequence) : undefined;
    if (!seq) continue;
    const fa = e.FinishAfter as number | undefined, ca = e.CancelAfter as number | undefined;
    out.push({
      owner: e.Account, sequence: Number(seq), destination: e.Destination, amountXrp: String(dropsToXrp(e.Amount)),
      finishAfter: fa ? fromRippleTime(fa) : undefined, cancelAfter: ca ? fromRippleTime(ca) : undefined,
      hasCondition: !!e.Condition,
      canFinishNow: !e.Condition && (!fa || now > fa) && (!ca || now < ca),
      canCancelNow: !!ca && now > ca,
      createdTx: e.PreviousTxnID,
    });
  }
  return out;
}

export async function prepareEscrowFinish(ledger: Ledger, input: EscrowRef & { account: string }): Promise<Prepared<EscrowFinish>> {
  assertAddress(input.account, "account");
  assertAddress(input.owner, "owner");
  const list = await listEscrows(ledger, input.owner);
  const e = list.find((x) => x.sequence === input.sequence);
  if (!e) throw new Error(`no escrow ${input.owner}#${input.sequence} on ${ledger.network} (already finished or cancelled?)`);
  if (!e.canFinishNow) throw new Error(e.canCancelNow ? "this escrow has expired — it can only be cancelled now"
                                                     : `not releasable yet — finishAfter is ${e.finishAfter}`);
  const tx: EscrowFinish = { TransactionType: "EscrowFinish", Account: input.account, Owner: input.owner, OfferSequence: input.sequence };
  const filled = await finalize(ledger, tx);
  return { network: ledger.network, tx: filled, warnings: [],
           summary: `Release ${e.amountXrp} XRP from escrow ${input.owner}#${input.sequence} to ${e.destination}`,
           details: { escrow: `${input.owner}#${input.sequence}`, amount: `${e.amountXrp} XRP`, to: e.destination,
                      signer: input.account, fee: `${dropsToXrp(filled.Fee!)} XRP` } };
}

export async function prepareEscrowCancel(ledger: Ledger, input: EscrowRef & { account: string }): Promise<Prepared<EscrowCancel>> {
  assertAddress(input.account, "account");
  assertAddress(input.owner, "owner");
  const list = await listEscrows(ledger, input.owner);
  const e = list.find((x) => x.sequence === input.sequence);
  if (!e) throw new Error(`no escrow ${input.owner}#${input.sequence} on ${ledger.network} (already finished or cancelled?)`);
  if (!e.canCancelNow) throw new Error(e.cancelAfter ? `not cancellable until ${e.cancelAfter}` : "this escrow has no cancelAfter — it can never be cancelled");
  const tx: EscrowCancel = { TransactionType: "EscrowCancel", Account: input.account, Owner: input.owner, OfferSequence: input.sequence };
  const filled = await finalize(ledger, tx);
  return { network: ledger.network, tx: filled, warnings: [],
           summary: `Cancel escrow ${input.owner}#${input.sequence}: return ${e.amountXrp} XRP to ${input.owner}`,
           details: { escrow: `${input.owner}#${input.sequence}`, amount: `${e.amountXrp} XRP`, returnsTo: input.owner,
                      signer: input.account, fee: `${dropsToXrp(filled.Fee!)} XRP` } };
}
