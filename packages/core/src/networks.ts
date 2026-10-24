// Public XRPL networks. Every endpoint here is an independent public node — nothing points at BURN/Ouroboros
// infrastructure. Override with XRPL_ENDPOINTS (comma-separated wss:// URLs) or the `endpoints` option.

export type NetworkId = "testnet" | "devnet" | "mainnet";

export interface NetworkInfo {
  id: NetworkId;
  name: string;
  endpoints: string[];
  faucet?: string;
  explorer: string;
  /** Signing on this network needs an explicit opt-in (real money). */
  realValue: boolean;
}

export const NETWORKS: Record<NetworkId, NetworkInfo> = {
  testnet: {
    id: "testnet", name: "XRPL Testnet", realValue: false,
    endpoints: ["wss://s.altnet.rippletest.net:51233", "wss://testnet.xrpl-labs.com"],
    faucet: "https://faucet.altnet.rippletest.net/accounts",
    explorer: "https://testnet.xrpl.org",
  },
  devnet: {
    id: "devnet", name: "XRPL Devnet", realValue: false,
    endpoints: ["wss://s.devnet.rippletest.net:51233"],
    faucet: "https://faucet.devnet.rippletest.net/accounts",
    explorer: "https://devnet.xrpl.org",
  },
  mainnet: {
    id: "mainnet", name: "XRPL Mainnet", realValue: true,
    endpoints: ["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"],
    explorer: "https://livenet.xrpl.org",
  },
};

export function explorerTx(network: NetworkId, hash: string): string {
  return `${NETWORKS[network].explorer}/transactions/${hash}`;
}
