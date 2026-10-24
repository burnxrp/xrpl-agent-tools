// Time conditions. Agents and humans give "+10m", an ISO date, or unix seconds; XRPL wants Ripple-epoch seconds.
import { isoTimeToRippleTime, rippleTimeToISOTime } from "xrpl";

const REL = /^\+(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i;
const UNIT: Record<string, number> = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400, day: 86400 };

/** Parse "+90s" | "+10m" | "+2h" | "+1d" | ISO-8601 | unix seconds → Date. */
export function parseWhen(input: string | number, now: Date = new Date()): Date {
  if (typeof input === "number") return new Date(input * 1000);
  const s = input.trim();
  const m = s.match(REL);
  if (m) return new Date(now.getTime() + Number(m[1]) * UNIT[m[2].toLowerCase()] * 1000);
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read time "${input}" — use +10m, +2h, an ISO date or unix seconds`);
  return d;
}

export const toRippleTime = (d: Date): number => isoTimeToRippleTime(d.toISOString());
export const fromRippleTime = (t: number): string => rippleTimeToISOTime(t);
