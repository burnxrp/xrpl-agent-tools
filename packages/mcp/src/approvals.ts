// Pending human approvals, kept on THIS machine only (~/.xrpl-agent/approvals.json). Nothing is sent anywhere.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Intent, LedgerProof } from "@xrpl-agent/core";

export type ApprovalStatus = "pending" | "rejected" | "submitted" | "confirmed" | "failed" | "expired";

export interface Approval {
  id: string;
  createdAt: string;
  network: string;
  intent: Intent;
  summary: string;
  details: Record<string, string>;
  warnings: string[];
  status: ApprovalStatus;
  hash?: string;
  proof?: LedgerProof;
  note?: string;
  /** x402 approvals: what the paid resource returned (kept for the agent). */
  response?: { status: number; contentType?: string; body: string; settlement?: unknown };
  /** Sent to the owner's phone (Xaman) as well as the console. */
  phone?: { uuid: string; url?: string; sentAt: string; state: "sent" | "signed" | "rejected" | "expired" | "cancelled" | "error"; note?: string };
}

type Listener = (a: Approval) => void;
const onAdd: Listener[] = [], onChange: Listener[] = [];

const DIR = process.env.XRPL_AGENT_HOME || join(homedir(), ".xrpl-agent");
const FILE = join(DIR, "approvals.json");

function load(): Approval[] {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return []; }
}

function save(list: Approval[]): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(list.slice(-200), null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
}

export const approvals = {
  list(): Approval[] { return load(); },
  get(id: string): Approval | undefined { return load().find((a) => a.id === id); },
  add(a: Omit<Approval, "id" | "createdAt" | "status">): Approval {
    const all = load();
    const full: Approval = { ...a, id: randomBytes(6).toString("hex"), createdAt: new Date().toISOString(), status: "pending" };
    all.push(full);
    save(all);
    for (const l of onAdd) { try { l(full); } catch { /* a listener never breaks approvals */ } }
    return full;
  },
  onAdd(l: Listener) { onAdd.push(l); },
  onChange(l: Listener) { onChange.push(l); },
  update(id: string, patch: Partial<Approval>): Approval | undefined {
    const all = load();
    const i = all.findIndex((a) => a.id === id);
    if (i < 0) return undefined;
    all[i] = { ...all[i], ...patch };
    save(all);
    for (const l of onChange) { try { l(all[i]); } catch { /* ignore */ } }
    return all[i];
  },
};
