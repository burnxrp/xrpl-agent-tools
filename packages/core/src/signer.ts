// Signing stays with whoever holds the key. This helper is for LOCAL wallets only (a Testnet dev wallet in the
// browser, or a separately-funded agent account later). A seed is never sent to any node or API.
import { Wallet } from "xrpl";

export function signLocally(seed: string, tx: Record<string, unknown>): { txBlob: string; hash: string; account: string } {
  const w = Wallet.fromSeed(seed);
  if (tx.Account && tx.Account !== w.classicAddress) throw new Error("this wallet is not the transaction's Account");
  const { tx_blob, hash } = w.sign(tx as any);
  return { txBlob: tx_blob, hash, account: w.classicAddress };
}
