/**
 * The device ledger: every transaction the enclave has ever labelled for this customer,
 * plus the decision cache that lets the enclave skip the model for narrations it has
 * already decided. Persisted ONLY as a JWE sealed to the device reply key (see vault.ts).
 *
 * The enclave is stateless between jobs; this is what carries state across them.
 */
import type { CachedDecision, LedgerTxn } from "../analysis/types";
import type { KV } from "../lib/storage";
import type { DeviceKeys } from "../lib/keys";
import { emptyCadence, recordFetch, type CadenceState } from "./cadence";
import { openJson, sealJson } from "./vault";
import type { DeltaDoc } from "../pfm/validate";
import type { DeltaRequest } from "../pfm/session";

export interface Ledger {
  v: 1;
  txns: LedgerTxn[];
  /** key hash (16 hex) -> decision. Insertion order = recency (most recent last). */
  decisions: Record<string, CachedDecision>;
  /** Latest transaction date held (YYYY-MM-DD). */
  watermark: string | null;
  taxonomy: string | null;
  cadence: CadenceState;
}

export const emptyLedger = (): Ledger => ({ v: 1, txns: [], decisions: {}, watermark: null, taxonomy: null, cadence: emptyCadence() });

/** The `known` map for the next job. Capped so the job stays far below the relay's 64 KB body limit. */
export function buildDeltaRequest(l: Ledger, maxKnown = 600): DeltaRequest {
  const keys = Object.keys(l.decisions).slice(-maxKnown);
  const known: DeltaRequest["known"] = {};
  for (const k of keys) {
    const d = l.decisions[k]!;
    if (l.taxonomy && d.taxonomyVersion !== l.taxonomy) continue; // stale taxonomy: let the model re-decide
    known[k] = [d.category, d.essential ? 1 : 0];
  }
  return { ...(l.watermark ? { since: l.watermark } : {}), ...(l.taxonomy ? { taxonomy: l.taxonomy } : {}), known };
}

export interface MergeResult {
  ledger: Ledger;
  added: number;
}

/** Merge an enclave delta. De-duplicates by txnId (the overlap day the bridge re-fetches); idempotent. */
export function mergeDelta(l: Ledger, d: DeltaDoc, now: Date): MergeResult {
  const decisions: Record<string, CachedDecision> = { ...l.decisions };
  const touch = (k: string, v: CachedDecision) => {
    delete decisions[k]; // re-insert: most recent last
    decisions[k] = v;
  };
  for (const [k, v] of Object.entries(d.newDecisions)) touch(k, { ...v, taxonomyVersion: d.taxonomy });

  const have = new Set(l.txns.map((t) => t.txnId));
  const fresh: LedgerTxn[] = [];
  for (const t of d.txns) {
    if (have.has(t.txnId)) continue;
    have.add(t.txnId);
    const { fromCache, ...row } = t;
    const cached = decisions[t.k];
    // The enclave does not know p for keys the device supplied; the device keeps its own.
    fresh.push(fromCache && cached ? { ...row, p: cached.p } : row);
    if (fromCache && cached) touch(t.k, cached);
  }
  // Stable by date only: within a day, arrival order is kept (the analysis tie-breaks on it, as the kit does).
  const txns = [...l.txns, ...fresh].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const watermark = txns.length ? txns[txns.length - 1]!.date : l.watermark;
  return {
    added: fresh.length,
    ledger: { v: 1, txns, decisions, watermark, taxonomy: d.taxonomy, cadence: recordFetch(l.cadence, now, fresh.length) },
  };
}

const KEY = "ledger";

export async function loadLedger(kv: KV, keys: DeviceKeys): Promise<Ledger> {
  const sealed = await kv.get<string>(KEY);
  if (!sealed) return emptyLedger();
  try {
    const l = await openJson<Ledger>(sealed, keys);
    return l?.v === 1 && Array.isArray(l.txns) ? l : emptyLedger();
  } catch {
    return emptyLedger(); // keys changed (forgotten device) — the ledger is unreadable by design
  }
}

export async function saveLedger(kv: KV, keys: DeviceKeys, l: Ledger): Promise<void> {
  await kv.set(KEY, await sealJson(l, keys));
}
