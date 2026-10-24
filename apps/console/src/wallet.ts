// Local Testnet/Devnet wallet for v1. The seed lives in this tab's sessionStorage only — it is never sent to any
// node, API or the agent; signing happens here. Mainnet signing is not offered in v1.
import { Wallet } from "xrpl";
import { signLocally } from "@xrpl-agent/core";

const KEY = "xrpl_agent_dev_wallet";

export interface DevWallet { address: string; network: string }

export function loadWallet(network: string): DevWallet | null {
  try {
    const w = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return w && w.network === network ? { address: w.address, network } : null;
  } catch { return null; }
}

export function saveSeed(seed: string, network: string): DevWallet {
  const w = Wallet.fromSeed(seed.trim());
  sessionStorage.setItem(KEY, JSON.stringify({ seed: seed.trim(), address: w.classicAddress, network }));
  return { address: w.classicAddress, network };
}

export function forgetWallet() { sessionStorage.removeItem(KEY); }

export function sign(tx: Record<string, unknown>): { txBlob: string; hash: string } {
  const w = JSON.parse(sessionStorage.getItem(KEY) || "null");
  if (!w?.seed) throw new Error("No wallet connected");
  return signLocally(w.seed, tx);
}
