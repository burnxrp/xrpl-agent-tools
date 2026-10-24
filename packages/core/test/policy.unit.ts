// Offline unit checks for agent policies: canonical token keys, validation, spend checks.
import { Wallet } from "xrpl";
import { checkSpend, defaultPolicy, validatePolicy, assetKey, displayKey, currencyCode } from "../src/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const owner = Wallet.generate().classicAddress, iss = Wallet.generate().classicAddress;
const T = { currency: "AGENTTOKEN", issuer: iss }, K = assetKey(T);

ok(K === `${currencyCode("AGENTTOKEN")}:${iss}` && K === assetKey({ currency: currencyCode("AGENTTOKEN"), issuer: iss }), "name and hex code give the same key");
ok(displayKey(K) === `AGENTTOKEN (${iss.slice(0, 6)}…)`, `display: ${displayKey(K)}`);
const p = { ...defaultPolicy(owner), tokens: { [K]: { perTx: "5", daily: "10" } } };
ok(validatePolicy(p).length === 0, "valid policy");
ok(checkSpend(defaultPolicy(owner), 0, { asset: T, amount: "1" }).why === `this agent may not spend ${displayKey(K)} (not in its token limits)`, "unlisted token refused by name");
ok(!checkSpend(p, 0, { asset: T, amount: "6" }).ok && checkSpend(p, 0, { asset: T, amount: "5" }).ok, "per-tx limit");
ok(!checkSpend(p, 6, { asset: T, amount: "5" }).ok && checkSpend(p, 5, { asset: T, amount: "5" }).ok, "24 h limit");
ok(checkSpend(p, 0, { asset: { currency: currencyCode("AGENTTOKEN"), issuer: iss }, amount: "5" }).ok, "hex-coded request matches the named limit");
const bad = (q: any, m: string) => { const e = validatePolicy(q); ok(e.length > 0, `${m} → ${e[0]}`); };
bad({ ...p, tokens: { [`AGENTTOKEN:${iss}`]: { perTx: "1", daily: "2" } } }, "raw long name as key");
bad({ ...p, tokens: { XRP: { perTx: "1", daily: "2" } } }, "XRP as a token");
bad({ ...p, tokens: { [K]: { perTx: "3", daily: "2" } } }, "per-tx above daily");
bad({ ...p, tokens: { [K]: { perTx: "1e3", daily: "2000" } } }, "exponent notation");
bad({ ...p, tokens: { [K]: { perTx: "0", daily: "2" } } }, "zero limit");
bad({ ...p, allowedDestinations: ["nope"] }, "bad destination");
bad({ ...p, allowedDestinations: [owner, owner] }, "duplicate destination");
bad({ ...p, tokens: Object.fromEntries(Array.from({ length: 51 }, () => [assetKey({ currency: "USD", issuer: Wallet.generate().classicAddress }), { perTx: "1", daily: "1" }])) }, "51 tokens");
console.log("ALL POLICY UNIT CHECKS PASSED");
