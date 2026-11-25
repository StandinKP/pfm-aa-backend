/** App state: everything the view renders, in one place. The view dispatches intents; the controller dispatches facts. */
import type { DerivedInsights } from "../analysis/derive";
import { DEFAULTS, type Config } from "./config";

export type Phase = "idle" | "working" | "interrupted" | "error";

export interface AppState {
  config: Config;
  phase: Phase;
  /** One line for the status area. */
  status: string;
  log: string[];
  insights: DerivedInsights | null;
  /** A full document from an enclave that predates delta mode; shown as-is, never stored in the ledger. */
  legacy: Record<string, unknown> | null;
  /** Where `insights` came from. */
  source: "ledger" | null;
  ledgerTxns: number;
  /** An unfinished job the user can resume. */
  pendingJobId: string | null;
  /** Cadence summary for the UI. */
  cadence: { manualAllowed: boolean; due: boolean; reason?: string; nextDueAt: string | null; fetchesLeft: number; lastFetchAt: string | null } | null;
  /** Last refresh's enclave workload, from the cleartext meta (counts only). */
  lastRun: { modelCalls: number; keysCached: number; newTxns: number; ms: number } | null;
}

export const initialState = (config: Config = DEFAULTS): AppState => ({
  config, phase: "idle", status: "", log: [], insights: null, legacy: null, source: null, ledgerTxns: 0, pendingJobId: null, cadence: null, lastRun: null,
});

export type Action =
  | { t: "config"; config: Config }
  | { t: "phase"; phase: Phase; status?: string }
  | { t: "log"; line: string }
  | { t: "insights"; insights: DerivedInsights | null; ledgerTxns: number }
  | { t: "legacy"; doc: Record<string, unknown> | null }
  | { t: "pending"; jobId: string | null }
  | { t: "cadence"; cadence: AppState["cadence"] }
  | { t: "lastRun"; lastRun: AppState["lastRun"] }
  | { t: "reset" };

const LOG_MAX = 200;

export function reduce(s: AppState, a: Action): AppState {
  switch (a.t) {
    case "config": return { ...s, config: a.config };
    case "phase": return { ...s, phase: a.phase, status: a.status ?? "" };
    case "log": return { ...s, log: [...s.log, a.line].slice(-LOG_MAX) };
    case "insights": return { ...s, insights: a.insights, legacy: a.insights ? null : s.legacy, source: a.insights ? "ledger" : null, ledgerTxns: a.ledgerTxns };
    case "legacy": return { ...s, legacy: a.doc };
    case "pending": return { ...s, pendingJobId: a.jobId };
    case "cadence": return { ...s, cadence: a.cadence };
    case "lastRun": return { ...s, lastRun: a.lastRun };
    case "reset": return initialState(s.config);
  }
}
