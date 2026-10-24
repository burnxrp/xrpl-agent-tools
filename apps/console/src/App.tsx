import { useCallback, useEffect, useMemo, useState } from "react";
import { Wallet, Client } from "xrpl";
import {
  Ledger, NETWORKS, type NetworkId, type AccountInfo, type EscrowEntry, type LedgerProof, type Prepared, type Intent,
  getAccount, getBalances, listEscrows, prepareEscrowCreate, prepareEscrowFinish, prepareEscrowCancel, submitSigned, verifyTx,
  preparePayment, type TokenBalance, type Asset, getAmm, getAmmPosition, getOrderBook, quoteSwap, prepareSwap, prepareLimitOrder,
  listOffers, prepareOfferCancel, prepareAmmDeposit, prepareAmmWithdraw, type AmmPool, type AmmPosition, type OrderBook,
  type OpenOffer, type SwapQuote, getClawbackStatus, listHolders, prepareEnableClawback, prepareClawback,
  type ClawbackStatus, type Holder, prepareX402Payment, transferMethod, listTickets, type X402Requirements,
} from "@xrpl-agent/core";
import { agentApi, readLink } from "./agent";
import { connectExtension, forgetWallet, loadWallet, saveSeed, sign, signAgentPolicy, WALLET_NAMES, xamanApiKey, setXamanApiKey, type DevWallet, type ExternalWallet } from "./wallet";
import { assetKey, displayKey, validatePolicy, type AgentPolicy } from "@xrpl-agent/core";

type Tool = "account" | "escrow" | "payments" | "clawback" | "dex" | "proof" | "agents";
const CATALOG: { id: Tool; name: string; sub: string; ready: boolean }[] = [
  { id: "account", name: "Account", sub: "Balances & permissions", ready: true },
  { id: "escrow", name: "Escrow", sub: "Create · Finish · Cancel", ready: true },
  { id: "payments", name: "Payments", sub: "XRP & issued tokens", ready: true },
  { id: "clawback", name: "Clawback", sub: "Issuer-only recovery", ready: true },
  { id: "dex", name: "DEX & AMM", sub: "Swap · Orders · Liquidity", ready: true },
  { id: "proof", name: "Ledger Proof", sub: "Validated transactions", ready: true },
  { id: "agents", name: "Agent accounts", sub: "Autonomous · capped by balance", ready: true },
];

// submit: hand the signed blob to someone other than the ledger directly (x402: the adapter pays the seller with it)
interface Review { title: string; prepared: Prepared<any>; onDone?: (p: LedgerProof) => void; submit?: (txBlob: string) => Promise<LedgerProof> }

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
    agentApi(link.token, "/session").then((s) => { setAgentNet(s.network); setNetwork(s.network); if (s.xamanApiKey && !xamanApiKey()) setXamanApiKey(s.xamanApiKey); }).catch(() => setAgentNet(null));
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
  // Mainnet signing only through an extension wallet (its key never touches this page); otherwise read-only.
  const locked = realValue && (!wallet || wallet.kind === "dev");

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo">◆</span> XRPL Agent Console</div>
        <select id="network" value={network} disabled={!!agentNet} onChange={(e) => setNetwork(e.target.value as NetworkId)}>
          {(Object.keys(NETWORKS) as NetworkId[]).map((n) => <option key={n} value={n}>{NETWORKS[n].name}</option>)}
        </select>
        {realValue && <span id="mainnet-pill" className="pill danger">MAINNET · real funds</span>}
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
          onWallet={(w) => { setWallet(w); flash(true, w.kind === "dev" ? "Wallet connected — its key stays in this tab only."
            : `${WALLET_NAMES[w.kind]} connected — it signs every transaction itself, after you confirm in the extension.`); }}
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
      {tool === "escrow" && <EscrowTool ledger={ledger} wallet={wallet} realValue={locked} onReview={setReview} onMsg={flash} />}
      {tool === "payments" && <PaymentsTool ledger={ledger} wallet={wallet} realValue={locked} onReview={setReview} onMsg={flash} />}
      {tool === "clawback" && <ClawbackTool ledger={ledger} wallet={wallet} realValue={locked} onReview={setReview} onMsg={flash} />}
      {tool === "dex" && <DexTool ledger={ledger} wallet={wallet} realValue={locked} onReview={setReview} onMsg={flash} />}
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
  if (wallet) return (
    <div className="row"><span className="pill">{WALLET_NAMES[wallet.kind]}</span>
      <button id="wallet-disconnect" className="ghost" onClick={onForget}>Disconnect</button></div>);
  const ext = (kind: ExternalWallet) => async () => {
    if (kind === "xaman" && !xamanApiKey()) {
      const k = window.prompt("Xaman API key (from apps.xaman.dev — it's public, not a secret). Add this page's address as an allowed origin there.");
      if (!k) return;
      setXamanApiKey(k);
    }
    setBusy(true);
    try { onWallet(await connectExtension(kind, network)); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (realValue) return (
    <div className="walletbox">
      <div className="small warn">Mainnet moves real funds. Connect a wallet app or extension; it holds the key and confirms every transaction.</div>
      <div className="row wrap">
        <button id="wallet-xaman" disabled={busy} onClick={ext("xaman")}>Xaman</button>
        <button id="wallet-joey" disabled={busy} onClick={ext("joey")}>Joey</button>
        <button id="wallet-gem" disabled={busy} onClick={ext("gem")}>GemWallet</button>
        <button id="wallet-crossmark" disabled={busy} onClick={ext("crossmark")}>Crossmark</button>
      </div>
    </div>);
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
      <div className="row wrap">
        <button id="wallet-xaman" className="ghost" disabled={busy} onClick={ext("xaman")}>Xaman</button>
        <button id="wallet-joey" className="ghost" disabled={busy} onClick={ext("joey")}>Joey</button>
        <button id="wallet-gem" className="ghost" disabled={busy} onClick={ext("gem")}>GemWallet</button>
        <button id="wallet-crossmark" className="ghost" disabled={busy} onClick={ext("crossmark")}>Crossmark</button>
      </div>
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

  if (!wallet) return <section className="card"><h2>Escrow</h2><p className="muted">Connect a wallet to create and manage escrows.</p></section>;
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
  if (!wallet) return <section className="card"><h2>Payments</h2><p className="muted">Connect a wallet to send payments.</p></section>;
  const chosen = asset === "XRP" ? "XRP" as const : (() => { const t = tokens[Number(asset)]; return { currency: t.code, issuer: t.issuer }; })();
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
      {p.changes && p.changes.length > 0 && <><dt>Balance changes</dt><dd>{p.changes.map((c, i) =>
        <div key={i} className={c.startsWith("-") ? "bad" : "good"}>{c}</div>)}</dd></>}
      <dt>Hash</dt><dd className="mono"><a href={p.explorer} target="_blank" rel="noreferrer">{p.hash}</a></dd>
    </dl>
  );
}

function ReviewModal({ ledger, review, onClose, onResult }: {
  ledger: Ledger; review: Review; onClose: () => void; onResult: (p: LedgerProof) => void;
}) {
  const [phase, setPhase] = useState<"review" | "submitting">("review"), [err, setErr] = useState("");
  const p = review.prepared, mainnet = ledger.network === "mainnet";
  const [ack, setAck] = useState(false);
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="sheet">
        <h2>{review.title}</h2>
        {mainnet && <p className="danger-banner">MAINNET — this moves real funds and cannot be undone.</p>}
        <p className="summary">{p.summary}</p>
        <dl className="kv">{Object.entries(p.details).map(([k, v]) => <div key={k} className="kvrow"><dt>{k}</dt><dd className="mono">{v}</dd></div>)}</dl>
        {p.warnings.map((w, i) => <p key={i} className="warn">⚠ {w}</p>)}
        <details><summary className="small">Exact transaction</summary><pre>{JSON.stringify(p.tx, null, 2)}</pre></details>
        {mainnet && <label className="row small" style={{ marginTop: 10 }}>
          <input id="review-ack" type="checkbox" style={{ width: "auto" }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
          I checked the details above and understand this uses real funds on the XRP Ledger Mainnet.</label>}
        {err && <p className="bad">{err}</p>}
        <div className="row end">
          <button id="review-cancel" className="ghost" disabled={phase === "submitting"} onClick={onClose}>Cancel</button>
          <button id="review-sign" disabled={phase === "submitting" || (mainnet && !ack)} onClick={async () => {
            setPhase("submitting"); setErr("");
            try {
              const { txBlob } = await sign(p.tx);
              const proof = review.submit ? await review.submit(txBlob)   // x402: the adapter pays the seller with it
                : await submitSigned(ledger, txBlob);                         // straight to the public XRPL node
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
                     warnings: string[]; status: string; hash?: string; proof?: LedgerProof; note?: string;
                     response?: { status: number; contentType?: string; body: string } }

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
    if (a.network !== ledger.network) return onMsg(false, `This request is for ${a.network}, but the console is on ${ledger.network}`);
    if (a.intent.tool === "x402") {
      try {
        // fresh quote from the seller via the adapter (invoices expire; the price can't go above what was requested)
        const { requirement } = await agentApi<{ requirement: X402Requirements }>(token, `/approvals/${a.id}/x402/quote`, { method: "POST", body: "{}" });
        let ticket: number | undefined;
        if (transferMethod(requirement) === "ticketSequence") {
          ticket = (await listTickets(ledger, i.account))[0];
          if (ticket === undefined) throw new Error("This seller requires an XRPL Ticket on your account — create one (TicketCreate) and approve again");
        }
        const prepared = await prepareX402Payment(ledger, i.account, requirement, { ticket });
        prepared.details = { ...prepared.details, for: `${i.method} ${i.url}` };
        onReview({ title: `Agent request · paid request · ${a.id}`, prepared,
          submit: async (txBlob) => {
            const done = await agentApi<Approval>(token, `/approvals/${a.id}/x402/redeem`, { method: "POST", body: JSON.stringify({ signedTxBlob: txBlob }) });
            load();
            if (!done.proof) throw new Error(done.note || "the payment wasn't confirmed on the ledger");
            if (done.status !== "confirmed") onMsg(false, done.note || `seller answered HTTP ${done.response?.status}`);
            return done.proof;
          } });
      } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); }
      return;
    }
    try {
      // Re-prepare fresh from the approved intent (transactions expire within ~a minute; intents don't).
      const prepared = a.intent.tool === "payment" ? await preparePayment(ledger, i)
        : a.intent.tool === "escrow_create"
        ? await prepareEscrowCreate(ledger, { account: i.account, destination: i.destination, amount: i.amount,
            finishAfter: i.finishAfter, cancelAfter: i.cancelAfter, destinationTag: i.destinationTag, memo: i.memo })
        : a.intent.tool === "escrow_finish" ? await prepareEscrowFinish(ledger, i)
        : a.intent.tool === "escrow_cancel" ? await prepareEscrowCancel(ledger, i)
        : a.intent.tool === "swap" ? await prepareSwap(ledger, i)            // keeps the agent's approved minimum
        : a.intent.tool === "limit_order" ? await prepareLimitOrder(ledger, i)
        : a.intent.tool === "offer_cancel" ? await prepareOfferCancel(ledger, i)
        : a.intent.tool === "amm_withdraw" ? await prepareAmmWithdraw(ledger, i)
        : a.intent.tool === "clawback_enable" ? await prepareEnableClawback(ledger, i)
        : a.intent.tool === "clawback" ? await prepareClawback(ledger, i)
        : await (async () => {
            const d = await prepareAmmDeposit(ledger, i);
            if (Number(d.amount2) > Number(i.amount2) * (1 + 1e-9))
              throw new Error(`The pool moved: this deposit now needs ${d.amount2} (approved ${i.amount2}). Ask the agent to request it again.`);
            return d;
          })();
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
        <div key={a.id} className="muted small">{a.status.toUpperCase()} · {a.summary}{a.proof ? ` · ${a.proof.result}` : ""}{a.response ? ` · seller HTTP ${a.response.status}` : ""}{a.note ? ` · ${a.note}` : ""}</div>))}</details>}
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
  const [tokRows, setTokRows] = useState<{ key: string; perTx: string; daily: string }[]>([]);
  const [held, setHeld] = useState<TokenBalance[]>([]), [newTok, setNewTok] = useState({ code: "", issuer: "" });
  function addToken(code: string, issuer: string) {
    try {
      const key = assetKey({ currency: code.trim(), issuer: issuer.trim() });
      if (tokRows.some((r) => r.key === key)) return onMsg(false, "That token already has limits");
      setTokRows([...tokRows, { key, perTx: "", daily: "" }]); setNewTok({ code: "", issuer: "" });
    } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); }
  }
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
              {Object.entries(a.policy.tokens).length > 0 && <div className="small">Tokens: {Object.entries(a.policy.tokens).map(([k, l]) =>
                `${displayKey(k)} ${l.perTx}/payment, ${l.daily}/24 h (spent ${+(a.spentLast24h[k] || 0).toFixed(6)})`).join(" · ")}</div>}
              <div className="muted small">owner {a.policy.owner}{mine ? " (you)" : ""} · policy v{a.policy.version}{Object.keys(a.policy.tokens).length === 0 ? " · may not spend any tokens" : ""}</div>
              {a.recent.slice(0, 3).map((r, k) => <div key={k} className="muted small">{new Date(r.at).toLocaleString()} · {r.kind} {r.amount} {r.asset.split(":")[0]} → {r.destination.slice(0, 8)}… · {r.result}</div>)}
              {edit === a.address && (
                <div className="form" style={{ marginTop: 8 }}>
                  <label>Max per payment (XRP)<input id={`agent-pertx-${a.address}`} value={form.perTx} onChange={(e) => setForm({ ...form, perTx: e.target.value })} /></label>
                  <label>Max per 24 h (XRP)<input id={`agent-daily-${a.address}`} value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} /></label>
                  <label>Allowed destinations (comma-separated, blank = any)<input id={`agent-allow-${a.address}`} value={form.allow} onChange={(e) => setForm({ ...form, allow: e.target.value })} /></label>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div className="label" style={{ margin: "6px 0" }}>Token limits <span className="muted">(tokens not listed can't be spent or sold)</span></div>
                    {tokRows.length === 0 && <p className="muted small">No tokens allowed.</p>}
                    {tokRows.map((r, k) => (
                      <div key={r.key} className="row" style={{ marginBottom: 6 }}>
                        <span className="small" style={{ minWidth: 150 }} title={r.key}>{displayKey(r.key)}</span>
                        <input id={`agent-tok-pertx-${k}`} placeholder="max per payment" value={r.perTx} onChange={(e) => setTokRows(tokRows.map((x, j) => j === k ? { ...x, perTx: e.target.value.trim() } : x))} />
                        <input id={`agent-tok-daily-${k}`} placeholder="max per 24 h" value={r.daily} onChange={(e) => setTokRows(tokRows.map((x, j) => j === k ? { ...x, daily: e.target.value.trim() } : x))} />
                        <button className="small ghost" onClick={() => setTokRows(tokRows.filter((_, j) => j !== k))}>Remove</button>
                      </div>))}
                    <div className="row">
                      {held.filter((h) => !tokRows.some((r) => r.key === assetKey({ currency: h.code, issuer: h.issuer }))).length > 0 &&
                        <select id="agent-tok-held" value="" onChange={(e) => { const h = held[Number(e.target.value)]; if (h) addToken(h.code, h.issuer); }}>
                          <option value="">+ a token this agent holds…</option>
                          {held.map((h, k) => <option key={k} value={k}>{h.currency} · {h.issuer.slice(0, 8)}… (bal {h.balance})</option>)}
                        </select>}
                      <input id="agent-tok-code" placeholder="or currency code" value={newTok.code} onChange={(e) => setNewTok({ ...newTok, code: e.target.value })} />
                      <input id="agent-tok-issuer" placeholder="issuer r…" value={newTok.issuer} onChange={(e) => setNewTok({ ...newTok, issuer: e.target.value.trim() })} />
                      <button id="agent-tok-add" className="small ghost" disabled={!newTok.code || !newTok.issuer} onClick={() => addToken(newTok.code, newTok.issuer)}>Add token</button>
                    </div>
                  </div>
                  <button id={`agent-save-${a.address}`} onClick={async () => {
                    try {
                      const policy: AgentPolicy = { ...a.policy, xrp: { perTx: form.perTx.trim(), daily: form.daily.trim() },
                        tokens: Object.fromEntries(tokRows.map((r) => [r.key, { perTx: r.perTx, daily: r.daily }])),
                        allowedDestinations: [...new Set(form.allow.split(",").map((x) => x.trim()).filter(Boolean))], version: a.policy.version + 1 };
                      const errs = validatePolicy(policy);
                      if (errs.length) throw new Error(errs.join("; "));
                      await agentApi(token, `/agents/${a.address}/policy`, { method: "POST", body: JSON.stringify({ policy,
                        ...(await signAgentPolicy(a.address, policy, (await getAccount(ledger, a.policy.owner)).sequence)) }) });
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
                setTokRows(Object.entries(a.policy.tokens).map(([key, l]) => ({ key, perTx: l.perTx, daily: l.daily })));
                setHeld([]); getBalances(ledger, a.address).then((b) => setHeld(b.tokens)).catch(() => {});
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

// ── DEX & AMM ─────────────────────────────────────────────────────────────────
function assetFrom(code: string, issuer: string): Asset {
  return code.trim().toUpperCase() === "XRP" || !code.trim() ? "XRP" : { currency: code.trim(), issuer: issuer.trim() };
}
function AssetInput({ id, label, code, issuer, setCode, setIssuer }: {
  id: string; label: string; code: string; issuer: string; setCode: (v: string) => void; setIssuer: (v: string) => void;
}) {
  const xrp = code.trim().toUpperCase() === "XRP";
  return (
    <>
      <label>{label}<input id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="XRP or currency code" /></label>
      {!xrp && <label>{label} issuer<input id={`${id}-issuer`} value={issuer} onChange={(e) => setIssuer(e.target.value.trim())} placeholder="r…" /></label>}
    </>
  );
}

function DexTool({ ledger, wallet, realValue, onReview, onMsg }: {
  ledger: Ledger; wallet: DevWallet | null; realValue: boolean; onReview: (r: Review) => void; onMsg: (ok: boolean, t: string) => void;
}) {
  const [aCode, setACode] = useState("XRP"), [aIss, setAIss] = useState(""), [bCode, setBCode] = useState(""), [bIss, setBIss] = useState("");
  const [amount, setAmount] = useState(""), [slip, setSlip] = useState("1"), [quote, setQuote] = useState<SwapQuote | null>(null);
  const [limitBuy, setLimitBuy] = useState(""), [depAmt, setDepAmt] = useState(""), [wdLp, setWdLp] = useState("");
  const [pool, setPool] = useState<AmmPool | null>(null), [pos, setPos] = useState<AmmPosition | null>(null), [book, setBook] = useState<OrderBook | null>(null);
  const [offers, setOffers] = useState<OpenOffer[]>([]), [busy, setBusy] = useState(false), [poolErr, setPoolErr] = useState("");
  const A = assetFrom(aCode, aIss), B = assetFrom(bCode, bIss);
  const pairOk = !!bCode.trim() && (B === "XRP" || /^r\w{24,34}$/.test(bIss)) && (A === "XRP" || /^r\w{24,34}$/.test(aIss));
  const lab = (x: Asset) => x === "XRP" ? "XRP" : x.currency;

  const load = useCallback(async () => {
    if (wallet) listOffers(ledger, wallet.address).then(setOffers).catch(() => setOffers([]));
    if (!pairOk) { setPool(null); setBook(null); return; }
    try {
      const p = await getAmm(ledger, A, B); setPool(p); setPoolErr("");
      setPos(wallet ? await getAmmPosition(ledger, wallet.address, p) : null);
    } catch (e) { setPool(null); setPos(null); setPoolErr(e instanceof Error ? e.message : String(e)); }
    getOrderBook(ledger, B, A, 5).then(setBook).catch(() => setBook(null));
  }, [ledger, wallet, aCode, aIss, bCode, bIss]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setQuote(null); load(); window.addEventListener("ledger-changed", load);
    return () => window.removeEventListener("ledger-changed", load); }, [load]);

  async function review(title: string, fn: () => Promise<Prepared<any>>) {
    setBusy(true);
    try { onReview({ title, prepared: await fn() }); } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  if (!wallet) return <section className="card"><h2>DEX & AMM</h2><p className="muted">Connect a wallet to trade or provide liquidity.</p></section>;
  const acct = wallet.address, off = busy || realValue;

  return (
    <section className="card">
      <h2>DEX & AMM <span className="muted small">native order book + AMM pools · ledger-routed</span></h2>
      <div className="form">
        <AssetInput id="dex-a" label="Sell / asset 1" code={aCode} issuer={aIss} setCode={setACode} setIssuer={setAIss} />
        <AssetInput id="dex-b" label="Buy / asset 2" code={bCode} issuer={bIss} setCode={setBCode} setIssuer={setBIss} />
        <button className="ghost" disabled={!pairOk} onClick={() => { setACode(bCode); setAIss(bIss); setBCode(aCode); setBIss(aIss); }}>⇅ Flip</button>
      </div>

      <h3>Swap <span className="muted small">fill-or-kill: you get at least the minimum, or nothing happens</span></h3>
      <div className="form">
        <label>Sell amount ({lab(A)})<input id="swap-amount" value={amount} onChange={(e) => { setAmount(e.target.value.trim()); setQuote(null); }} placeholder="10" /></label>
        <label>Max slippage %<input id="swap-slip" value={slip} onChange={(e) => setSlip(e.target.value.trim())} /></label>
        <button id="swap-quote" className="ghost" disabled={!pairOk || !amount} onClick={async () => {
          try { setQuote(await quoteSwap(ledger, A, B, amount)); } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); } }}>Quote</button>
        <button id="swap-review" disabled={off || !pairOk || !amount} onClick={() => review("Swap",
          () => prepareSwap(ledger, { account: acct, sell: A, amount, buy: B, slippagePct: Number(slip) || 1 }))}>Review swap</button>
      </div>
      {quote && <p className="small">≈ <b>{quote.expectedOut.toPrecision(8)} {lab(B)}</b> via {quote.via} · AMM {quote.ammOut.toPrecision(6)} · book {quote.bookOut.toPrecision(6)}
        {quote.priceImpactPct !== undefined && <> · impact {quote.priceImpactPct.toFixed(2)}%</>}</p>}

      <h3>Limit order <span className="muted small">rests on the book until filled or cancelled</span></h3>
      <div className="form">
        <label>Sell ({lab(A)})<input id="lim-sell" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="10" /></label>
        <label>For ({lab(B)})<input id="lim-buy" value={limitBuy} onChange={(e) => setLimitBuy(e.target.value.trim())} placeholder="100" /></label>
        <button id="lim-review" disabled={off || !pairOk || !amount || !limitBuy} onClick={() => review("Place limit order",
          () => prepareLimitOrder(ledger, { account: acct, sell: A, sellAmount: amount, buy: B, buyAmount: limitBuy }))}>Review order</button>
      </div>
      {book && (book.bids.length > 0 || book.asks.length > 0) && <p className="small muted">
        Book {lab(B)}/{lab(A)}: best bid {book.bestBid?.toPrecision(6) ?? "—"} · best ask {book.bestAsk?.toPrecision(6) ?? "—"} {lab(A)} per {lab(B)}</p>}

      <h3>Liquidity pool</h3>
      {!pairOk ? <p className="muted small">Enter a pair to see its AMM pool.</p> : !pool ? <p className="muted small">{poolErr || "Loading…"}</p> : <>
        <dl className="kv">
          <dt>Reserves</dt><dd>{pool.amount1.toPrecision(8)} {lab(A)} · {pool.amount2.toPrecision(8)} {lab(B)}</dd>
          <dt>Spot price</dt><dd>{pool.spotPrice.toPrecision(6)} {lab(B)} per {lab(A)}</dd>
          <dt>Trading fee</dt><dd>{pool.tradingFeePct}%</dd>
          <dt>LP supply</dt><dd>{pool.lpToken.value}</dd>
          {pos && <><dt>Your position</dt><dd>{pos.lpTokens} LP ({pos.sharePct.toFixed(4)}%) ≈ {pos.worth1.toPrecision(6)} {lab(A)} + {pos.worth2.toPrecision(6)} {lab(B)}</dd></>}
        </dl>
        <div className="form">
          <label>Deposit {lab(A)} (+ matching {lab(B)})<input id="amm-dep" value={depAmt} onChange={(e) => setDepAmt(e.target.value.trim())} placeholder="5" /></label>
          <button id="amm-dep-review" disabled={off || !depAmt} onClick={() => review("Add liquidity",
            () => prepareAmmDeposit(ledger, { account: acct, asset1: A, asset2: B, amount1: depAmt }))}>Review deposit</button>
          <label>Withdraw LP tokens<input id="amm-wd" value={wdLp} onChange={(e) => setWdLp(e.target.value.trim())} placeholder={pos ? String(pos.lpTokens) : ""} /></label>
          <button id="amm-wd-review" disabled={off || !wdLp} onClick={() => review("Remove liquidity",
            () => prepareAmmWithdraw(ledger, { account: acct, asset1: A, asset2: B, lpTokens: wdLp }))}>Review withdraw</button>
          <button id="amm-wd-all" className="ghost" disabled={off || !pos?.lpTokens} onClick={() => review("Withdraw everything",
            () => prepareAmmWithdraw(ledger, { account: acct, asset1: A, asset2: B, all: true }))}>Withdraw all</button>
        </div>
      </>}

      <h3>Your open orders</h3>
      {offers.length === 0 ? <p className="muted small">None.</p> : <table className="tbl"><thead><tr><th>#</th><th>Sells</th><th>Wants</th><th>Price</th><th /></tr></thead>
        <tbody>{offers.map((o) => <tr key={o.sequence}><td>{o.sequence}</td><td>{o.sells}</td><td>{o.wants}</td><td>{o.price.toPrecision(6)}</td>
          <td className="actions"><button className="small ghost" disabled={off} onClick={() => review(`Cancel order #${o.sequence}`,
            () => prepareOfferCancel(ledger, { account: acct, sequence: o.sequence }))}>Cancel</button></td></tr>)}</tbody></table>}
    </section>
  );
}

// ── Issuer clawback ───────────────────────────────────────────────────────────
function ClawbackTool({ ledger, wallet, realValue, onReview, onMsg }: {
  ledger: Ledger; wallet: DevWallet | null; realValue: boolean; onReview: (r: Review) => void; onMsg: (ok: boolean, t: string) => void;
}) {
  const [st, setSt] = useState<ClawbackStatus | null>(null), [holders, setHolders] = useState<Holder[]>([]);
  const [amts, setAmts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!wallet) return;
    try { setSt(await getClawbackStatus(ledger, wallet.address)); setHolders(await listHolders(ledger, wallet.address)); }
    catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); }
  }, [ledger, wallet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); window.addEventListener("ledger-changed", load); return () => window.removeEventListener("ledger-changed", load); }, [load]);
  async function review(title: string, fn: () => Promise<Prepared<any>>) {
    setBusy(true);
    try { onReview({ title, prepared: await fn() }); } catch (e) { onMsg(false, e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  if (!wallet) return <section className="card"><h2>Clawback</h2><p className="muted">Connect the issuer's wallet.</p></section>;
  const off = busy || realValue, key = (h: Holder) => `${h.holder}:${h.code}`;
  return (
    <section className="card">
      <h2>Clawback <span className="muted small">issuer-only · XLS-39 · for the connected wallet as issuer</span></h2>
      {!st ? <p className="muted">Loading…</p> : st.enabled
        ? <p className="good">Clawback is enabled for this issuer (permanent). Holders can see this on your account.</p>
        : st.canEnable ? <>
            <p>Clawback is <b>off</b>. You can enable it now because this account owns nothing on the ledger yet. <b>It can never be turned off</b>, and it must happen before you issue tokens.</p>
            <button id="cb-enable" disabled={off} onClick={() => review("Enable clawback (permanent)", () => prepareEnableClawback(ledger, { account: wallet.address }))}>Review: enable clawback</button>
          </>
        : <p className="muted">Clawback is off and can't be enabled: {st.why}.</p>}
      <h3>Holders of your tokens</h3>
      {holders.length === 0 ? <p className="muted small">No one holds tokens issued by this account.</p> :
        <table className="tbl"><thead><tr><th>Holder</th><th>Token</th><th>Balance</th><th /></tr></thead><tbody>
          {holders.map((h) => <tr key={key(h)}><td className="mono">{h.holder}</td><td>{h.currency}{h.frozen ? " · frozen" : ""}</td><td>{h.balance}</td>
            <td className="actions">{st?.enabled && <>
              <input style={{ width: 110 }} value={amts[key(h)] ?? ""} placeholder="amount" onChange={(e) => setAmts({ ...amts, [key(h)]: e.target.value.trim() })} />
              <button className="small" disabled={off || !amts[key(h)]} onClick={() => review("Claw back tokens",
                () => prepareClawback(ledger, { account: wallet.address, holder: h.holder, currency: h.code, amount: amts[key(h)] }))}>Claw back</button></>}
            </td></tr>)}
        </tbody></table>}
    </section>
  );
}
