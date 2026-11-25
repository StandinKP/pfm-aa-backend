/**
 * Runtime shape checks at the trust boundary. The reply is decrypted JSON from outside
 * the app: never cast it, check it. Narrations stay untrusted strings (rendered via textContent only).
 */
import type { LedgerTxn } from "../analysis/types";

export class ReplyShapeError extends Error {
  override name = "ReplyShapeError";
}

export const DELTA_SCHEMA = "urn:sahamati:pfm-delta:1";

export interface DeltaDecision {
  category: string;
  p: number;
  essential: boolean;
}

export interface DeltaDoc {
  schema: typeof DELTA_SCHEMA;
  taxonomy: string;
  /** Echo of the request watermark (null on the first sync). */
  since: string | null;
  /** Records the enclave received for this job (after its own `since` filter). */
  recordsIn: number;
  /** Rows for transactions the device does not have yet, each with its label and `k`. */
  txns: Array<LedgerTxn & { k: string; fromCache: boolean }>;
  /** Decisions the model made THIS job, by key hash. Everything else came from the device's `known`. */
  newDecisions: Record<string, DeltaDecision>;
}

const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string";
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const bad = (what: string): never => {
  throw new ReplyShapeError(what);
};

export function parseDelta(raw: unknown): DeltaDoc {
  if (!isRec(raw) || raw["schema"] !== DELTA_SCHEMA) return bad("not a delta document");
  if (!str(raw["taxonomy"]) || !num(raw["recordsIn"]) || !Array.isArray(raw["txns"]) || !isRec(raw["newDecisions"])) return bad("delta fields");
  const txns = (raw["txns"] as unknown[]).map((t, i) => {
    if (!isRec(t) || !str(t["txnId"]) || !str(t["date"]) || !/^\d{4}-\d{2}-\d{2}/.test(t["date"]) || !num(t["amount"]) || !str(t["type"]) || !str(t["mode"]) ||
      !str(t["narration"]) || !str(t["accountLabel"]) || !str(t["category"]) || !num(t["p"]) || typeof t["essential"] !== "boolean" || !str(t["k"])) {
      return bad(`txn ${i}`);
    }
    return { ...(t as unknown as LedgerTxn), k: t["k"] as string, date: (t["date"] as string).slice(0, 10), fromCache: t["fromCache"] === true };
  });
  const nd: Record<string, DeltaDecision> = {};
  for (const [k, v] of Object.entries(raw["newDecisions"] as Record<string, unknown>)) {
    if (!isRec(v) || !str(v["category"]) || !num(v["p"]) || typeof v["essential"] !== "boolean") return bad(`decision ${k}`);
    nd[k] = { category: v["category"] as string, p: v["p"] as number, essential: v["essential"] as boolean };
  }
  return {
    schema: DELTA_SCHEMA,
    taxonomy: raw["taxonomy"] as string,
    since: str(raw["since"]) ? (raw["since"] as string) : null,
    recordsIn: raw["recordsIn"] as number,
    txns,
    newDecisions: nd,
  };
}

/** Minimum the UI needs from a full (schema-2) insights document; the rest passes through untouched. */
export function checkInsights(raw: unknown): void {
  if (!isRec(raw)) return bad("insights document");
  const totals = raw["totals"];
  if (!isRec(totals) || !num(totals["spend"]) || !num(totals["income"]) || !Array.isArray(raw["outflowsByCategory"]) || !Array.isArray(raw["accounts"]) || !num(raw["recordsIn"])) {
    return bad("insights document");
  }
  for (const c of raw["outflowsByCategory"] as unknown[]) {
    if (!isRec(c) || !str(c["category"]) || !num(c["total"])) return bad("outflowsByCategory entry");
  }
}
