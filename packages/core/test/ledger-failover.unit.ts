// Ledger failover: a rate-limited endpoint is skipped and the request retried on the next public node.
import { Ledger } from "../src/index.js";
const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
async function main() {
  const l = new Ledger({ network: "testnet", endpoints: ["wss://s.altnet.rippletest.net:51233", "wss://testnet.xrpl-labs.com"] });
  const c = await l.client();
  const first = l.endpoint;
  const real = c.request.bind(c);
  (c as any).request = async () => { throw Object.assign(new Error("rate limit: units quota (10000 per 60s) exhausted, retry in ~41143ms"), { data: { error: "slowDown" } }); };
  const r = await l.request<any>({ command: "server_info" });
  ok(!!r.info && l.endpoint !== first, `rate-limited on ${first.replace("wss://", "")} → answered by ${l.endpoint.replace("wss://", "")}`);
  ok((await l.client()) !== c && l.endpoint !== first, "stays off the throttled endpoint");
  void real; await l.close();
  console.log("ALL FAILOVER CHECKS PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
