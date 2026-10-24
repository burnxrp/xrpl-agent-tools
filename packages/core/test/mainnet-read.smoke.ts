// Read-only mainnet smoke test through the default public endpoints (with rate-limit failover). Signs nothing.
import { Ledger, getAccount, getAmm } from "../src/index.js";
async function main() {
  const l = new Ledger({ network: "mainnet" });
  const a = await getAccount(l, "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");   // genesis account (public)
  console.log(`  ✓ mainnet account read via ${l.endpoint}: genesis exists=${a.exists}, ownerCount=${a.ownerCount}`);
  const close = await l.validatedCloseTime();
  console.log(`  ✓ validated close time ${close} via ${l.endpoint}`);
  await l.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
