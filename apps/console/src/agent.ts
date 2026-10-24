// When the console is opened from an agent's review link, it talks to the LOCAL MCP adapter (same origin) using the
// per-session token from the link. Standalone (static hosting / file), there is no agent and no API.
export function readLink(): { token: string | null; approveId: string | null } {
  const h = window.location.hash;                       // #/approve/<id>?token=… or #/?token=…
  const q = new URLSearchParams(h.split("?")[1] || "");
  const m = h.match(/#\/approve\/([0-9a-f]{12})/);
  const token = q.get("token") || sessionStorage.getItem("agent_token");
  if (token) sessionStorage.setItem("agent_token", token);
  return { token, approveId: m ? m[1] : null };
}

export async function agentApi<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json", "X-Agent-Console-Token": token, ...(init.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
