import { useCallback, useEffect, useMemo, useState } from "react";
import { Wallet, Client } from "xrpl";
import {
  Ledger, NETWORKS, type NetworkId, type AccountInfo, type EscrowEntry, type LedgerProof, type Prepared, type Intent,
  getAccount, getBalances, listEscrows, prepareEscrowCreate, prepareEscrowFinish, prepareEscrowCancel, submitSigned, verifyTx,
  preparePayment, type TokenBalance,
} from "@xrpl-agent/core";
import { agentApi, readLink } from "./agent";
import { forgetWallet, loadWallet, saveSeed, sign, signAgentPolicy, type DevWallet } from "./wallet";
import type { AgentPolicy } from "@xrpl-agent/core";

type Tool = "account" | "escrow" | "payments" | "clawback" | "dex" | "proof" | "agents";
const CATALOG: { id: Tool; name: string; sub: string; ready: boolean }[] = [
  { id: "account", name: "Account", sub: "Balances & permissions", ready: true },
  { id: "escrow", name: "Escrow", sub: "Create · Finish · Cancel", ready: true },
  { id: "payments", name: "Payments", sub: "XRP & issued tokens", ready: true },
  { id: "clawback", name: "Clawback", sub: "Issuer-only recovery", ready: false },
  { id: "dex", name: "DEX & AMM", sub: "Trading & liquidity", ready: false },
  { id: "proof", name: "Ledger Proof", sub: "Validated transactions", ready: true },
  { id: "agents", name: "Agent accounts", sub: "Autonomous · capped by balance", ready: true },
];

interface Review { title: string; prepared: Prepared<any>; onDone?: (p: LedgerProof) => void }

export default function App() {
  const link = useMemo(readLink, []);
  const [network, setNetwork] = useState<NetworkId>("testnet");
  const ledger = useMemo(() => new Ledger({ network }), [network]);
  const [endpoint, setEndpoint] = useState("");
  const [wallet, setWallet] = useState<DevWallet | null>(null);
  const [acct, setAcct] = useState<AccountInfo | null>(null);
  const [tool, setTool] = useState<Tool>(link.approveId ? "escrow" : "escrow");
  const [review, setReview] = useState<Review | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [agentNet, setAgentNet] = useState<string | null>(null);

  // agent mode: the local adapter decides the network
  useEffect(() => {
    if (!link.token) return;
    agentApi(link.token, "/session").then((s) => { setAgentNet(s.network); setNetwork(s.network); }).catch(() => setAgentNet(null));
  }, [link.token]);

  useEffect(() => { setWallet(loadWallet(network)); }, [network]);
  useEffect(() => { ledger.client().then(() => setEndpoint(ledger.endpoint)).catch(() => setEndpoint("")); return () => { ledger.close(); }; }, [ledger]);

  const refresh = useCallback(async () => {
    if (!wallet) { setAcct(null); return; }
    try { setAcct(await getAccount(ledger, wallet.address)); } catch { /* keep last */ }
  }, [ledger, wallet]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  const flash = (ok: boolean, text: string) => { setToast({ ok, text }); setTimeout(() => setToast(null), 6000); };
  const realValue = NETWORKS[network].realValue;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo">◆</span> XRPL Agent Console</div>
        <select id="network" value={network} disabled={!!agentNet} onChange={(e) => setNetwork(e.target.value as NetworkId)}>
          {(Object.keys(NETWORKS) as NetworkId[]).map((n) => <option key={n} value={n}>{NETWORKS[n].name}</option>)}
        </select>
        <span className={`pill ${endpoint ? "ok" : "bad"}`}>{endpoint ? `● ${endpoint.replace("wss://", "")}` : "○ connecting…"}</span>
      </header>

      <section className="card account">
        <div>
          <div className="label">Connected account</div>
          {wallet ? (
            <>
              <div className="addr" id="wallet-address">{wallet.address}</div>
              <div className="muted">{acct ? (acct.exists ? `${acct.balanceXrp} XRP · ${acct.spendableXrp} spendable · reserve ${acct.reserveXrp}` : "not activated on this network") : "loading…"}</div>
            </>
          ) : <div className="muted">Wallet not connected</div>}
        </div>
        <WalletControls network={network} realValue={realValue} wallet={wallet} ledger={ledger}
          onWallet={(w) => { setWallet(w); flash(true, "Wallet connected — its key stays in this tab only."); }}
          onForget={() => { forgetWallet(); setWallet(null); }} onError={(m) => flash(false, m)} />
      </section>
      <p className="muted small">Direct connection to public XRPL nodes · Local interface · No proprietary backend</p>

      {link.token && agentNet && <AgentInbox token={link.token} focusId={link.approveId} ledger={ledger} wallet={wallet}
        onReview={setReview} onMsg={flash} />}

      <nav className="catalog">
        {CATALOG.map((t) => (
          <button key={t.id} id={`tool-${t.id}`} className={`tile ${tool === t.id ? "on" : ""}`} disabled={!t.ready} onClick={() => setTool(t.id)}>
            <b>{t.name}</b><span>{t.sub}</span>{!t.ready && <em>next</em>}
          </button>
        ))}
      </nav>

      {tool === "account" && <AccountTool acct={acct} network={network} />}
      {tool === "escrow" && <EscrowTool ledger={ledger} wallet={wallet} realValue={realValue} onReview={setReview} onMsg={flash} />}
      {tool === "payments" && <PaymentsTool ledger={ledger} wallet={wallet} realValue={realValue} onReview={setReview} onMsg={flash} />}
      {tool === "proof" && <ProofTool ledger={ledger} />}
      {tool === "agents" && <AgentsTool token={link.token} ledger={ledger} wallet={wallet} onReview={setReview} onMsg={flash} />}

      {review && <ReviewModal ledger={ledger} review={review} onClose={() => setReview(null)}
        onResult={(p) => { setReview(null); refresh(); window.dispatchEvent(new Event("ledger-changed")); flash(p.success, p.success ? `Validated on ledger ${p.ledgerIndex} — ${p.result}` : `Ledger result: ${p.result}`); }} />}
      {toast && <div className={`toast ${toast.ok ? "ok" : "bad"}`} role="status">{toast.text}</div>}
    </div>
  );
}

function WalletControls({ network, realValue, wallet, ledger, onWallet, onForget, onError }: {
  network: NetworkId; realValue: boolean; wallet: DevWallet | null; ledger: Ledger;
  onWallet: (w: DevWallet) => void; onForget: () => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState("");
  if (wallet) return <button id="wallet-disconnect" className="ghost" onClick={onForget}>Disconnect</button>;
  if (realValue) return <div className="muted small">Mainnet is read-only in v1. Wallet signing is Testnet / Devnet.</div>;
  return (
    <div className="walletbox">
      <button id="wallet-create" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const c: Client = await ledger.client();
          const { wallet: w } = await c.fundWallet(null, { faucetHost: NETWORKS[network].faucet?.replace("https://", "").replace("/accounts", "") });
          onWallet(saveSeed(w.seed!, network));
        } catch (e) { onError(`Faucet failed: ${e instanceof Error ? e.message : e}`); } finally { setBusy(false); }
      }}>{busy ? "Funding…" : `Create ${NETWORKS[network].name} wallet`}</button>
      <div className="row">
        <input id="wallet-seed" type="password" placeholder="or paste a Testnet seed (s…)" value={seed} onChange={(e) => setSeed(e.target.value)} autoComplete="off" />
        <button id="wallet-import" className="ghost" disabled={!seed} onClick={() => {
          try { Wallet.fromSeed(seed.trim()); onWallet(saveSeed(seed, network)); setSeed(""); } catch { onError("That isn't a valid seed"); }
        }}>Import</button>
      </div>
    </div>
  );
}

function AccountTool({ acct, network }: { acct: AccountInfo | null; network: NetworkId }) {
  if (!acct) return <section className="card"><p className="muted">Connect a wallet to see its ledger state.</p></section>;
  return (
    <section className="card">
      <h2>Account</h2>
      <dl className="kv">
        <dt>Address</dt><dd className="mono">{acct.address}</dd>
        <dt>Activated</dt><dd>{acct.exists ? "yes" : "no"}</dd>
        <dt>Balance</dt><dd>{acct.balanceXrp} XRP</dd>
        <dt>Reserve (locked)</dt><dd>{acct.reserveXrp} XRP</dd>
        <dt>Spendable</dt><dd>{acct.spendableXrp} XRP</dd>
        <dt>Owned objects</dt><dd>{acct.ownerCount}</dd>
        <dt>Flags</dt><dd>{Object.entries(acct.flags).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}</dd>
      </dl>
      <a className="small" href={`${NETWORKS[network].explorer}/accounts/${acct.address}`} target="_blank" rel="noreferrer">Open in explorer ↗</a>
    </section>
  );
}

function EscrowTool({ ledger, wallet, realValue, onReview, onMsg }: {
  ledger: Ledger; wallet: DevWallet | null; realValue: boolean; onReview: (r: Review) => void; onMsg: (ok: boolean, t: string) => void;
}) {
  const [dest, setDest] = useState(""), [amount, setAmount] = useState("5");
  const [finishAfter, setFinish] = useState("+10m"), [cancelAfter, setCancel] = useState("+1d");
  const [list, setList] = useState<EscrowEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!wallet) return setList([]);
    try { setList(await listEscrows(ledger, wallet.address)); } catch { /* keep */ }
  }, [ledger, wallet]);
  useEffect(() => {
    load(); const t = setInterval(load, 10000);
    window.addEventListener("ledger-changed", load);   // any approval (yours or an agent's) refreshes the list
    return () => { clearInterval(t); window.removeEventListener("ledger-changed", load); };
  }, [load]);

  async function prep(fn: () => Promise<Prepared<any>>, title: string) {
    setBusy(true);
    try { onReview({ title, prepared: await fn(), onDone: load }); }
    catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  if (!wallet) return <section className="card"><h2>Escrow</h2><p className="muted">Connect a Testnet wallet to create and manage escrows.</p></section>;
  return (
    <section className="card">
      <h2>Escrow <span className="muted small">native EscrowCreate · EscrowFinish · EscrowCancel</span></h2>
      <div className="form">
        <label>Recipient<input id="escrow-dest" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="r…" /></label>
        <label>Amount (XRP)<input id="escrow-amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Release after<input id="escrow-finish" value={finishAfter} onChange={(e) => setFinish(e.target.value)} placeholder="+10m · ISO date" /></label>
        <label>Refundable after<input id="escrow-cancel" value={cancelAfter} onChange={(e) => setCancel(e.target.value)} placeholder="+1d (blank = never)" /></label>
        <button id="escrow-create" disabled={busy || realValue || !dest} onClick={() => prep(() => prepareEscrowCreate(ledger,
          { account: wallet.address, destination: dest.trim(), amount, finishAfter, cancelAfter: cancelAfter.trim() || undefined }), "Create escrow")}>
          Review escrow
        </button>
      </div>
      <h3>Escrows <button id="escrow-refresh" className="ghost small" onClick={load}>refresh</button></h3>
      {list.length === 0 ? <p className="muted">No open escrows for this account.</p> : (
        <table className="tbl">
          <thead><tr><th>Escrow</th><th>Amount</th><th>To</th><th>Release after</th><th>Refund after</th><th /></tr></thead>
          <tbody>{list.map((e) => (
            <tr key={`${e.owner}-${e.sequence}`}>
              <td className="mono">{e.owner === wallet.address ? "you" : e.owner.slice(0, 8) + "…"}#{e.sequence}</td>
              <td>{e.amountXrp} XRP</td>
              <td className="mono">{e.destination === wallet.address ? "you" : e.destination.slice(0, 8) + "…"}</td>
              <td>{e.finishAfter ? new Date(e.finishAfter).toLocaleString() : "—"}</td>
              <td>{e.cancelAfter ? new Date(e.cancelAfter).toLocaleString() : "never"}</td>
              <td className="actions">
                <button id={`escrow-finish-${e.sequence}`} disabled={!e.canFinishNow || busy || realValue}
                  onClick={() => prep(() => prepareEscrowFinish(ledger, { account: wallet.address, owner: e.owner, sequence: e.sequence }), "Release escrow")}>Finish</button>
                <button id={`escrow-cancel-${e.sequence}`} className="ghost" disabled={!e.canCancelNow || busy || realValue}
                  onClick={() => prep(() => prepareEscrowCancel(ledger, { account: wallet.address, owner: e.owner, sequence: e.sequence }), "Cancel escrow")}>Cancel</button>
              </td>
            </tr>))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PaymentsTool({ ledger, wallet, realValue, onReview, onMsg }: {
  ledger: Ledger; wallet: DevWallet | null; realValue: boolean; onReview: (r: Review) => void; onMsg: (ok: boolean, t: string) => void;
}) {
  const [dest, setDest] = useState(""), [amount, setAmount] = useState(""), [tag, setTag] = useState(""), [memo, setMemo] = useState("");
  const [tokens, setTokens] = useState<TokenBalance[]>([]), [asset, setAsset] = useState("XRP"), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!wallet) return;
    getBalances(ledger, wallet.address).then((b) => setTokens(b.tokens)).catch(() => setTokens([]));
  }, [ledger, wallet]);
  if (!wallet) return <section className="card"><h2>Payments</h2><p className="muted">Connect a Testnet wallet to send payments.</p></section>;
  const chosen = asset === "XRP" ? "XRP" as const : (() => { const t = tokens[Number(asset)]; return { currency: t.currency, issuer: t.issuer }; })();
  return (
    <section className="card">
      <h2>Payments <span className="muted small">native Payment · exact delivery (never partial)</span></h2>
      <div className="form">
        <label>Recipient<input id="pay-dest" value={dest} onChange={(e) => setDest(e.target.value.trim())} placeholder="r…" /></label>
        <label>Asset<select id="pay-asset" value={asset} onChange={(e) => setAsset(e.target.value)}>
          <option value="XRP">XRP</option>
          {tokens.map((t, k) => <option key={k} value={k}>{t.currency} · {t.issuer.slice(0, 8)}… (bal {t.balance})</option>)}
        </select></label>
        <label>Amount<input id="pay-amount" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="12.5" /></label>
        <label>Destination tag<input id="pay-tag" value={tag} onChange={(e) => setTag(e.target.value.replace(/\D/g, ""))} placeholder="optional" /></label>
        <label>Memo<input id="pay-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="optional" maxLength={200} /></label>
        <button id="pay-review" disabled={busy || realValue || !dest || !amount} onClick={async () => {
          setBusy(true);
          try {
            onReview({ title: "Send payment", prepared: await preparePayment(ledger, { account: wallet.address, destination: dest, amount,
              asset: chosen, destinationTag: tag ? Number(tag) : undefined, memo: memo || undefined }) });
          } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
        }}>Review payment</button>
      </div>
    </section>
  );
}

function ProofTool({ ledger }: { ledger: Ledger }) {
  const [hash, setHash] = useState(""), [p, setP] = useState<LedgerProof | null>(null), [err, setErr] = useState("");
  return (
    <section className="card">
      <h2>Ledger Proof</h2>
      <div className="row">
        <input id="proof-hash" value={hash} onChange={(e) => setHash(e.target.value.trim())} placeholder="transaction hash" />
        <button id="proof-verify" onClick={async () => { setErr(""); setP(null);
          try { setP(await verifyTx(ledger, hash.toUpperCase())); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } }}>Verify</button>
      </div>
      {err && <p className="bad">{err}</p>}
      {p && <ProofView p={p} />}
    </section>
  );
}

function ProofView({ p }: { p: LedgerProof }) {
  return (
    <dl className="kv">
      <dt>Result</dt><dd className={p.success ? "good" : "bad"}>{p.result} {p.validated ? "· validated" : "· NOT validated"}</dd>
      <dt>Type</dt><dd>{p.type}</dd>
      <dt>Ledger</dt><dd>{p.ledgerIndex}</dd>
      {p.escrow && <><dt>Escrow</dt><dd className="mono">{p.escrow.owner}#{p.escrow.sequence}</dd></>}
      {p.delivered && <><dt>Delivered</dt><dd>{p.delivered}</dd></>}
      <dt>Hash</dt><dd className="mono"><a href={p.explorer} target="_blank" rel="noreferrer">{p.hash}</a></dd>
    </dl>
  );
}

function ReviewModal({ ledger, review, onClose, onResult }: {
  ledger: Ledger; review: Review; onClose: () => void; onResult: (p: LedgerProof) => void;
}) {
  const [phase, setPhase] = useState<"review" | "submitting">("review"), [err, setErr] = useState("");
  const p = review.prepared;
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="sheet">
        <h2>{review.title}</h2>
        <p className="summary">{p.summary}</p>
        <dl className="kv">{Object.entries(p.details).map(([k, v]) => <div key={k} className="kvrow"><dt>{k}</dt><dd className="mono">{v}</dd></div>)}</dl>
        {p.warnings.map((w, i) => <p key={i} className="warn">⚠ {w}</p>)}
        <details><summary className="small">Exact transaction</summary><pre>{JSON.stringify(p.tx, null, 2)}</pre></details>
        {err && <p className="bad">{err}</p>}
        <div className="row end">
          <button id="review-cancel" className="ghost" disabled={phase === "submitting"} onClick={onClose}>Cancel</button>
          <button id="review-sign" disabled={phase === "submitting"} onClick={async () => {
            setPhase("submitting"); setErr("");
            try {
              const { txBlob } = sign(p.tx);
              const proof = await submitSigned(ledger, txBlob);   // straight to the public XRPL node
              review.onDone?.(proof);
              onResult(proof);
            } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPhase("review"); }
          }}>{phase === "submitting" ? "Signing & waiting for validation…" : "Approve & sign"}</button>
        </div>
      </div>
    </div>
  );
}

interface Approval { id: string; createdAt: string; network: string; intent: Intent; summary: string; details: Record<string, string>;
                     warnings: string[]; status: string; hash?: string; proof?: LedgerProof; note?: string }

function AgentInbox({ token, focusId, ledger, wallet, onReview, onMsg }: {
  token: string; focusId: string | null; ledger: Ledger; wallet: DevWallet | null; onReview: (r: Review) => void; onMsg: (ok: boolean, t: string) => void;
}) {
  const [list, setList] = useState<Approval[]>([]);
  const load = useCallback(async () => { try { setList((await agentApi(token, "/approvals")).approvals); } catch (e) { onMsg(false, String(e)); } }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  const pending = list.filter((a) => a.status === "pending");
  const recent = list.filter((a) => a.status !== "pending").slice(0, 5);

  async function approve(a: Approval) {
    const i: any = a.intent.input;
    if (!wallet) return onMsg(false, "Connect the wallet that must sign first");
    if (wallet.address !== i.account) return onMsg(false, `This request must be signed by ${i.account} — connect that wallet`);
    try {
      // Re-prepare fresh from the approved intent (transactions expire within ~a minute; intents don't).
      const prepared = a.intent.tool === "payment" ? await preparePayment(ledger, i)
        : a.intent.tool === "escrow_create"
        ? await prepareEscrowCreate(ledger, { account: i.account, destination: i.destination, amount: i.amount,
            finishAfter: i.finishAfter, cancelAfter: i.cancelAfter, destinationTag: i.destinationTag, memo: i.memo })
        : a.intent.tool === "escrow_finish" ? await prepareEscrowFinish(ledger, i) : await prepareEscrowCancel(ledger, i);
      onReview({ title: `Agent request · ${a.id}`, prepared, onDone: async (proof) => {
        try { await agentApi(token, `/approvals/${a.id}/result`, { method: "POST", body: JSON.stringify({ hash: proof.hash }) }); }
        catch (e) { onMsg(false, `Ledger result recorded, but the agent wasn't told: ${e}`); }
        load();
      } });
    } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); }
  }

  return (
    <section className="card inbox">
      <h2>Agent requests <span className="muted small">your AI agent asked for these — nothing happens unless you approve</span></h2>
      {pending.length === 0 ? <p className="muted">No pending requests.</p> : pending.map((a) => (
        <div key={a.id} className={`req ${a.id === focusId ? "focus" : ""}`}>
          <div><b>{a.summary}</b><div className="muted small">{a.intent.tool} · {new Date(a.createdAt).toLocaleString()} · {a.network}</div>
            {a.warnings.map((w, k) => <div key={k} className="warn small">⚠ {w}</div>)}</div>
          <div className="row">
            <button id={`approve-${a.id}`} onClick={() => approve(a)}>Review & sign</button>
            <button id={`reject-${a.id}`} className="ghost" onClick={async () => { await agentApi(token, `/approvals/${a.id}/reject`, { method: "POST" }); load(); }}>Reject</button>
          </div>
        </div>
      ))}
      {recent.length > 0 && <details><summary className="small">Recent</summary>{recent.map((a) => (
        <div key={a.id} className="muted small">{a.status.toUpperCase()} · {a.summary}{a.proof ? ` · ${a.proof.result}` : ""}{a.note ? ` · ${a.note}` : ""}</div>))}</details>}
    </section>
  );
}

interface AgentView { address: string; label: string; owner: string; exposureCapXrp: string; balanceXrp: string; activated: boolean;
  policy: AgentPolicy; spentLast24h: Record<string, number>; recent: { at: string; amount: string; asset: string; destination: string; result: string; kind: string }[] }

function AgentsTool({ token, ledger, wallet, onReview, onMsg }: {
  token: string | null; ledger: Ledger; wallet: DevWallet | null; onReview: (r: Review) => void; onMsg: (ok: boolean, t: string) => void;
}) {
  const [list, setList] = useState<AgentView[]>([]);
  const [edit, setEdit] = useState<string | null>(null);
  const [form, setForm] = useState({ perTx: "", daily: "", allow: "" });
  const load = useCallback(async () => { if (token) try { setList((await agentApi(token, "/agents")).agents); } catch (e) { onMsg(false, String(e)); } }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const t = setInterval(load, 8000); window.addEventListener("ledger-changed", load);
    return () => { clearInterval(t); window.removeEventListener("ledger-changed", load); }; }, [load]);
  if (!token) return <section className="card"><h2>Agent accounts</h2><p className="muted">Agent accounts live with your AI agent. Open the console from your agent (its review link or xrpl_network_info) to manage them.</p></section>;
  return (
    <section className="card">
      <h2>Agent accounts <span className="muted small">the agent spends on its own — never more than the balance you fund</span></h2>
      {list.length === 0 ? <p className="muted">No agent accounts yet. Your agent can create one with xrpl_agent_account_create.</p> : list.map((a) => {
        const mine = wallet?.address === a.policy.owner;
        return (
          <div key={a.address} className="req">
            <div>
              <b>{a.label}</b> <span className="mono small">{a.address}</span>
              <div className="small">Can spend at most <b>{a.exposureCapXrp} XRP</b> (its balance) · limits {a.policy.xrp.perTx} per payment, {a.policy.xrp.daily} per 24 h
                · spent {+(a.spentLast24h.XRP || 0).toFixed(6)} today{a.policy.allowedDestinations.length ? ` · only to ${a.policy.allowedDestinations.length} allowed address(es)` : " · any destination"}</div>
              <div className="muted small">owner {a.policy.owner}{mine ? " (you)" : ""} · policy v{a.policy.version}</div>
              {a.recent.slice(0, 3).map((r, k) => <div key={k} className="muted small">{new Date(r.at).toLocaleString()} · {r.kind} {r.amount} {r.asset.split(":")[0]} → {r.destination.slice(0, 8)}… · {r.result}</div>)}
              {edit === a.address && (
                <div className="form" style={{ marginTop: 8 }}>
                  <label>Max per payment (XRP)<input id={`agent-pertx-${a.address}`} value={form.perTx} onChange={(e) => setForm({ ...form, perTx: e.target.value })} /></label>
                  <label>Max per 24 h (XRP)<input id={`agent-daily-${a.address}`} value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} /></label>
                  <label>Allowed destinations (comma-separated, blank = any)<input id={`agent-allow-${a.address}`} value={form.allow} onChange={(e) => setForm({ ...form, allow: e.target.value })} /></label>
                  <button id={`agent-save-${a.address}`} onClick={async () => {
                    try {
                      const policy: AgentPolicy = { ...a.policy, xrp: { perTx: form.perTx, daily: form.daily },
                        allowedDestinations: form.allow.split(",").map((x) => x.trim()).filter(Boolean), version: a.policy.version + 1 };
                      await agentApi(token, `/agents/${a.address}/policy`, { method: "POST", body: JSON.stringify({ policy, ...signAgentPolicy(a.address, policy) }) });
                      onMsg(true, "New limits signed by your wallet and applied."); setEdit(null); load();
                    } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); }
                  }}>Sign & save limits</button>
                </div>)}
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button id={`agent-fund-${a.address}`} disabled={!wallet} onClick={async () => {
                const amt = window.prompt("Fund this agent account with how many XRP? This is the most it can ever spend.", "25");
                if (!amt || !wallet) return;
                try { onReview({ title: "Fund agent account", prepared: await preparePayment(ledger, { account: wallet.address, destination: a.address, amount: amt, asset: "XRP", memo: "agent funding" }), onDone: load }); }
                catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); }
              }}>Fund</button>
              <button id={`agent-edit-${a.address}`} className="ghost" disabled={!mine} title={mine ? "" : "connect the owner wallet"} onClick={() => {
                setEdit(edit === a.address ? null : a.address);
                setForm({ perTx: a.policy.xrp.perTx, daily: a.policy.xrp.daily, allow: a.policy.allowedDestinations.join(", ") });
              }}>Edit limits</button>
              <button id={`agent-return-${a.address}`} className="ghost" onClick={async () => {
                if (!window.confirm("Send everything spendable back to the owner?")) return;
                try { const r = await agentApi(token, `/agents/${a.address}/return`, { method: "POST", body: "{}" }); onMsg(r.proof.success, `Returned ${r.proof.delivered} — ${r.proof.result}`); load(); }
                catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); }
              }}>Return funds to owner</button>
            </div>
          </div>);
      })}
    </section>
  );
}
