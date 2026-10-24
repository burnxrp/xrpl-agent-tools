// Local console (127.0.0.1 only): serves the human dashboard and a tiny approvals API. Every API call needs the
// per-session token from the review link, so other websites open in the same browser can't touch approvals.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Ledger, verifyTx, matchesIntent } from "@xrpl-agent/core";
import { approvals } from "./approvals.js";
import { listAgents, agentStatus, updatePolicy, returnToOwner } from "./agents.js";
import { quoteX402, redeemX402 } from "./x402-approvals.js";

export const SESSION_TOKEN = randomBytes(24).toString("hex");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon" };

function consoleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.XRPL_AGENT_CONSOLE_DIR, join(here, "../../../apps/console/dist"), join(here, "../console")];
  return candidates.find((d) => d && existsSync(join(d, "index.html"))) || "";
}

function authed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
  const t = String(req.headers["x-agent-console-token"] || "");
  return t.length === SESSION_TOKEN.length && timingSafeEqual(Buffer.from(t), Buffer.from(SESSION_TOKEN));
}

async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 100_000) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}

function send(res: ServerResponse, code: number, data: unknown, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(data) : (data as any));
}

export function startConsoleServer(ledger: Ledger, port: number): Promise<number> {
  const root = consoleDir();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith("/api/")) {
        if (!authed(req, port)) return send(res, 401, { error: "missing or wrong console token — open the review link from your agent" });
        if (url.pathname === "/api/session") return send(res, 200, { network: ledger.network, endpoints: ledger.endpoints,
                                                                     xamanApiKey: process.env.XRPL_XAMAN_API_KEY || undefined });   // public app key, not a secret
        if (url.pathname === "/api/approvals" && req.method === "GET") return send(res, 200, { approvals: approvals.list().slice().reverse() });
        if (url.pathname === "/api/agents" && req.method === "GET") {
          const list = await Promise.all(listAgents(ledger.network).map((a) => agentStatus(ledger, a.address).catch(() => ({ ...a, error: true }))));
          return send(res, 200, { agents: list });
        }
        const am = url.pathname.match(/^\/api\/agents\/(r[1-9A-HJ-NP-Za-km-z]{24,34})\/(policy|return)$/);
        if (am && req.method === "POST") {
          // A policy change needs the OWNER wallet's signature (the session token alone is not enough —
          // an agent that learned the review link still can't raise its own limits).
          if (am[2] === "policy") { const b = await body(req); return send(res, 200, { policy: updatePolicy(am[1], b.policy, { publicKey: b.publicKey, signature: b.signature, proofTx: b.proofTx }) }); }
          const b = await body(req);
          return send(res, 200, { proof: await returnToOwner(ledger, am[1], b.amount) });
        }
        const xm = url.pathname.match(/^\/api\/approvals\/([0-9a-f]{12})\/x402\/(quote|redeem)$/);
        if (xm && req.method === "POST") {
          const a = approvals.get(xm[1]);
          if (!a) return send(res, 404, { error: "unknown approval" });
          if (a.status !== "pending") return send(res, 409, { error: `already ${a.status}` });
          if (a.network !== ledger.network) return send(res, 409, { error: `approval is for ${a.network}` });
          try {
            if (xm[2] === "quote") return send(res, 200, { requirement: await quoteX402(ledger, a) });
            const b = await body(req);
            return send(res, 200, await redeemX402(ledger, a, String(b.signedTxBlob ?? "")));
          } catch (e: any) { return send(res, 409, { error: String(e?.message || e) }); }
        }
        const m = url.pathname.match(/^\/api\/approvals\/([0-9a-f]{12})\/(reject|result)$/);
        if (m && req.method === "POST") {
          const a = approvals.get(m[1]);
          if (!a) return send(res, 404, { error: "unknown approval" });
          if (a.status !== "pending") return send(res, 409, { error: `already ${a.status}` });
          if (m[2] === "reject") return send(res, 200, approvals.update(a.id, { status: "rejected", note: "rejected by the human" }));
          if (a.intent.tool === "x402") return send(res, 409, { error: "x402 approvals are paid through /x402/redeem" });
          const { hash } = await body(req);
          if (!/^[0-9A-F]{64}$/i.test(String(hash))) return send(res, 400, { error: "bad hash" });
          // Independently check the ledger: validated, and exactly what was approved.
          const proof = await verifyTx(ledger, hash);
          const tx = (await ledger.request<any>({ command: "tx", transaction: hash }));
          const match = matchesIntent(a.intent, tx.tx_json ?? tx);
          if (!match.ok) return send(res, 409, approvals.update(a.id, { status: "failed", hash, proof, note: `does not match approval: ${match.why}` }));
          return send(res, 200, approvals.update(a.id, { status: proof.success ? "confirmed" : "failed", hash, proof }));
        }
        return send(res, 404, { error: "not found" });
      }
      if (!root) return send(res, 503, "Console UI not built — run: npm run build", "text/plain");
      const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      const file = join(root, path);
      if (!file.startsWith(root) || !existsSync(file)) return send(res, 200, await readFile(join(root, "index.html")), "text/html");
      return send(res, 200, await readFile(file), MIME[extname(file)] || "application/octet-stream");
    } catch (e: any) {
      return send(res, 500, { error: String(e?.message || e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}
