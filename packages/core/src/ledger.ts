// One connection to a public XRPL network, with failover across independent endpoints.
import { Client } from "xrpl";
import { NETWORKS, type NetworkId } from "./networks.js";

export interface LedgerOptions {
  network?: NetworkId;
  /** Explicit public endpoints (wss://…). Defaults to the network's list, or XRPL_ENDPOINTS. */
  endpoints?: string[];
  connectionTimeoutMs?: number;
}

export class Ledger {
  readonly network: NetworkId;
  readonly endpoints: string[];
  private _client: Client | null = null;
  private _endpoint = "";
  private readonly timeout: number;

  constructor(opts: LedgerOptions = {}) {
    this.network = opts.network ?? "testnet";
    const env = typeof process !== "undefined" ? process.env?.XRPL_ENDPOINTS : undefined;
    this.endpoints = opts.endpoints?.length ? opts.endpoints
      : env ? env.split(",").map((s) => s.trim()).filter(Boolean)
      : NETWORKS[this.network].endpoints;
    this.timeout = opts.connectionTimeoutMs ?? 10_000;
  }

  /** The endpoint currently in use. */
  get endpoint(): string { return this._endpoint; }

  /** A connected client — first reachable endpoint wins; reconnects transparently. */
  async client(): Promise<Client> {
    if (this._client?.isConnected()) return this._client;
    let lastErr: unknown;
    for (const url of this.endpoints) {
      const c = new Client(url, { connectionTimeout: this.timeout });
      try {
        await c.connect();
        this._client = c;
        this._endpoint = url;
        return c;
      } catch (e) {
        lastErr = e;
        try { await c.disconnect(); } catch { /* ignore */ }
      }
    }
    throw new Error(`No XRPL endpoint reachable (${this.endpoints.join(", ")}): ${String(lastErr)}`);
  }

  async request<T = any>(req: Record<string, unknown>): Promise<T> {
    const c = await this.client();
    return (await c.request(req as any)).result as T;
  }

  /** Ripple-epoch close time of the latest validated ledger (what escrow time conditions are judged against). */
  async validatedCloseTime(): Promise<number> {
    const r = await this.request<any>({ command: "ledger", ledger_index: "validated" });
    return Number(r.ledger.close_time);
  }

  async close(): Promise<void> {
    if (this._client) { try { await this._client.disconnect(); } catch { /* ignore */ } }
    this._client = null;
  }
}
