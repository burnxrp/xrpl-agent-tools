// Wallets the console can sign with. Keys never reach this page's code paths for extension wallets, and never leave
// the browser for the dev wallet:
//  - dev:       a Testnet/Devnet seed in this tab's sessionStorage (signed here with xrpl.js) — never on Mainnet
//  - gem:       GemWallet browser extension (the extension holds the key and shows its own confirmation)
//  - crossmark: Crossmark browser extension (same)
// Whatever an extension returns is decoded and compared with the transaction the human reviewed before it's submitted.
import { Wallet, decode } from "xrpl";
import { signLocally, signPolicy as signPolicyCore, policyProofTx, type AgentPolicy } from "@xrpl-agent/core";

const KEY = "xrpl_agent_dev_wallet";
const EXT_KEY = "xrpl_agent_ext_wallet";

export type WalletKind = "dev" | "gem" | "crossmark";
export interface DevWallet { address: string; network: string; kind: WalletKind }   // name kept: used across the app
export const WALLET_NAMES: Record<WalletKind, string> = { dev: "Dev wallet (this tab)", gem: "GemWallet", crossmark: "Crossmark" };

export function loadWallet(network: string): DevWallet | null {
  try {
    const e = JSON.parse(sessionStorage.getItem(EXT_KEY) || "null");
    if (e && e.network === network) return { address: e.address, network, kind: e.kind };
    const w = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return w && w.network === network && network !== "mainnet" ? { address: w.address, network, kind: "dev" } : null;
  } catch { return null; }
}

export function saveSeed(seed: string, network: string): DevWallet {
  if (network === "mainnet") throw new Error("Seeds are never entered on Mainnet — use GemWallet or Crossmark");
  const w = Wallet.fromSeed(seed.trim());
  sessionStorage.removeItem(EXT_KEY);
  sessionStorage.setItem(KEY, JSON.stringify({ seed: seed.trim(), address: w.classicAddress, network }));
  return { address: w.classicAddress, network, kind: "dev" };
}

export function forgetWallet() { sessionStorage.removeItem(KEY); sessionStorage.removeItem(EXT_KEY); }

function current(): { kind: WalletKind; address: string; network?: string; seed?: string } {
  const e = JSON.parse(sessionStorage.getItem(EXT_KEY) || "null");
  if (e) return e;
  const w = JSON.parse(sessionStorage.getItem(KEY) || "null");
  if (w?.seed) return { kind: "dev", address: w.address, seed: w.seed };
  throw new Error("No wallet connected");
}

// ── extensions (loaded only when chosen) ─────────────────────────────────────
// Exact match on chain AND network: GemWallet reports "Mainnet" for Xahau too, and Crossmark's `label` is the chain
// ("xrp ledger" / "xahau") with the network in `type`.
interface WalletNet { chain: string; network: string }
const sameNetwork = (w: WalletNet, ours: string) => w.chain === "xrpl" && w.network === ours.toLowerCase();
const describe = (w: WalletNet) => w.network ? `${w.chain === "xrpl" ? "" : w.chain + " "}${w.network}` : "an unknown network";
const gemNet = (r: any): WalletNet => ({ chain: String(r?.result?.chain ?? "").toLowerCase(), network: String(r?.result?.network ?? "").toLowerCase() });
const crossNet = (n: any): WalletNet => ({ chain: String(n?.label ?? "").toLowerCase() === "xrp ledger" ? "xrpl" : String(n?.label ?? "?").toLowerCase(),
                                           network: String(n?.type ?? "").toLowerCase() });

async function crossmark() {
  const mod: any = await import("@crossmarkio/sdk");
  return mod.default?.default ?? mod.default;
}

/** The network the extension is on right now (users can switch it at any time). */
async function extensionNetwork(kind: "gem" | "crossmark"): Promise<WalletNet> {
  if (kind === "gem") return gemNet(await (await import("@gemwallet/api")).getNetwork());
  return crossNet((await crossmark())?.session?.network);
}

export { sameNetwork as _sameNetwork, gemNet as _gemNet, crossNet as _crossNet };

export async function connectExtension(kind: "gem" | "crossmark", network: string): Promise<DevWallet> {
  let address: string, walletNet: WalletNet;
  if (kind === "gem") {
    const gem = await import("@gemwallet/api");
    if (!(await gem.isInstalled()).result?.isInstalled) throw new Error("GemWallet isn't installed in this browser (gemwallet.app)");
    const a = await gem.getAddress();
    if (a.type === "reject" || !a.result?.address) throw new Error("GemWallet: connection refused");
    const n = await gem.getNetwork();
    address = a.result.address; walletNet = gemNet(n);
  } else {
    const sdk = await crossmark();
    if (!sdk?.sync?.isInstalled?.()) {
      await sdk?.async?.detect?.(2000).catch?.(() => {});
      if (!sdk?.sync?.isInstalled?.()) throw new Error("Crossmark isn't installed in this browser (crossmark.io)");
    }
    const r = await sdk.methods.signInAndWait();
    address = r?.response?.data?.address; walletNet = crossNet(r?.response?.data?.network);
    if (!address) throw new Error("Crossmark: sign-in refused");
  }
  if (!sameNetwork(walletNet, network))
    throw new Error(`${WALLET_NAMES[kind]} is on ${describe(walletNet)} — switch it to XRPL ${network} (or switch the console)`);
  sessionStorage.removeItem(KEY);
  sessionStorage.setItem(EXT_KEY, JSON.stringify({ kind, address, network }));
  return { address, network, kind };
}

/** Refuse a signed blob that differs from what the human reviewed (wallets may only add fee/sequence/signature). */
export function assertSignedMatches(prepared: Record<string, any>, txBlob: string) {
  const signed = decode(txBlob) as Record<string, any>;
  const ignore = new Set(["Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "TxnSignature", "Flags", "NetworkID"]);
  for (const k of new Set([...Object.keys(prepared), ...Object.keys(signed)])) {
    if (ignore.has(k)) continue;
    if (JSON.stringify(signed[k]) !== JSON.stringify(prepared[k])) throw new Error(`The wallet changed "${k}" — not submitted`);
  }
  const FULLY_CANONICAL = 0x80000000;
  if (((Number(signed.Flags) || 0) & ~FULLY_CANONICAL) >>> 0 !== ((Number(prepared.Flags) || 0) & ~FULLY_CANONICAL) >>> 0)
    throw new Error("The wallet changed the transaction flags — not submitted");
  if (Number(signed.Fee) > Math.max(Number(prepared.Fee) * 10, 2000)) throw new Error(`The wallet set a fee of ${signed.Fee} drops — not submitted`);
  if (signed.Account !== prepared.Account) throw new Error("Signed by a different account — not submitted");
}

export async function sign(tx: Record<string, any>): Promise<{ txBlob: string }> {
  const w = current();
  if (w.kind === "dev") return signLocally(w.seed!, tx);
  const now = await extensionNetwork(w.kind);
  if (!w.network || !sameNetwork(now, w.network))
    throw new Error(`${WALLET_NAMES[w.kind]} is now on ${describe(now)}, not XRPL ${w.network} — switch it back before signing`);
  let txBlob: string | undefined;
  if (w.kind === "gem") {
    const gem = await import("@gemwallet/api");
    const r = await gem.signTransaction({ transaction: tx as any });
    if (r.type === "reject") throw new Error("Rejected in GemWallet");
    txBlob = r.result?.signature ?? undefined;
  } else {
    const r = await (await crossmark()).methods.signAndWait(tx);
    txBlob = r?.response?.data?.txBlob;
    if (!txBlob) throw new Error("Rejected in Crossmark");
  }
  if (!txBlob) throw new Error("The wallet returned no signed transaction");
  assertSignedMatches(tx, txBlob);
  return { txBlob };
}

/** Owner approves an agent's spending policy. Dev wallet: message signature. Extensions: a signed approval
 *  transaction that can never be applied on the ledger (see core/agent-policy policyProofTx). */
export async function signAgentPolicy(agent: string, policy: AgentPolicy, ownerSequence: number):
    Promise<{ publicKey: string; signature: string } | { proofTx: string }> {
  const w = current();
  if (w.kind === "dev") return signPolicyCore(w.seed!, agent, policy);
  if (w.address !== policy.owner) throw new Error("Connect the owner's wallet to change this agent's limits");
  return { proofTx: (await sign(policyProofTx(agent, policy, ownerSequence))).txBlob };
}
