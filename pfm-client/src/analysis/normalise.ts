/**
 * Narration normalisation and the dedupe key — questions.py. `keyHash` is the
 * decision-cache key the device sends/receives (never the narration itself).
 */
import { utf8 } from "../lib/bytes";

const DIGITS = /\d+/g;
const SPACES = /\s+/g;

/** Upper-case, drop the first "SYNTHETIC", digits -> "#", collapse spaces. Idempotent on already-normalised text. */
export function normaliseNarration(narration: string): string {
  let t = String(narration ?? "").toUpperCase();
  t = t.replace("SYNTHETIC", "");
  t = t.replace(DIGITS, "#");
  return t.replace(SPACES, " ").trim();
}

/** (type lower, mode UPPER, normalised narration) — the kit's `record_key`. */
export function recordKey(r: { type: string; mode: string; narration: string }): [string, string, string] {
  return [String(r.type ?? "").toLowerCase(), String(r.mode ?? "").toUpperCase(), normaliseNarration(r.narration)];
}

export const keyString = (k: readonly [string, string, string]): string => k.join("\u0000");

/** Lower-case hex sha256 of `type|MODE|normalisedNarration`. */
export async function keyHash(type: string, mode: string, narration: string): Promise<string> {
  const [t, m, n] = recordKey({ type, mode, narration });
  const digest = await crypto.subtle.digest("SHA-256", utf8(`${t}|${m}|${n}`) as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
