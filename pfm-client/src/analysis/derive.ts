/**
 * Derive the full insights document (schema pfm-insights:2) from the device's
 * labelled ledger — port of pfm-tee-kit/pfm/insights.py `build_document`. Pure:
 * same ledger in, same document out; no model, no network.
 *
 * Ledger order: keep (date, arrival) order, as the kit's record order — it
 * decides tie-breaks. An empty ledger throws RangeError (there is no "as of").
 */
import { buildLists, detectRecurring, labelsOf, rollups, type ListRow } from "./aggregate";
import { buildBehaviour, type Behaviour, type Preferences } from "./behaviour";
import { select, type NudgeSelection, type Ranker } from "./nudges";
import { pyRound } from "./num";
import { TAXONOMY_URN, UNCLASSIFIED } from "./taxonomy";
import type { DeriveOptions, LedgerTxn } from "./types";

export { keyHash, normaliseNarration, recordKey } from "./normalise";

export const INSIGHTS_SCHEMA = "urn:sahamati:pfm-insights:2";
export const DEFAULT_LIST_MAX = 50;

export interface DeriveExtras extends DeriveOptions {
  /** Provenance of the labels (the enclave's decider); defaults to a device-derived marker. */
  decider?: { backend: string; version: string };
  /** Optional nudge ranker (see nudges.ts). Omitted = severity order, no model. */
  rank?: Ranker;
  nudgeMax?: number;
  nudgeMinP?: number;
}

export interface DerivedInsights {
  schema: string;
  taxonomy: string;
  period: { from: string; to: string } | null;
  accounts: string[];
  recordsIn: number;
  outflowsByCategory: ReturnType<typeof rollups>["outflowsByCategory"];
  inflowsByCategory: ReturnType<typeof rollups>["inflowsByCategory"];
  months: ReturnType<typeof rollups>["months"];
  totals: ReturnType<typeof rollups>["totals"];
  topCategories: string[];
  recurring: ReturnType<typeof detectRecurring>;
  unclassified: { count: number; sharePct: number };
  labels: Array<{ txnId: string; category: string; p: number; essential: boolean; recurring: boolean }>;
  lists: Record<string, ListRow[]>;
  behaviour: Behaviour;
  nudges: NudgeSelection;
  decider: { backend: string; version: string };
}

export function deriveInsights(txns: readonly LedgerTxn[], opts: DeriveExtras = {}): DerivedInsights {
  if (!txns.length) throw new RangeError("deriveInsights: empty ledger");
  const listMax = opts.listMax ?? DEFAULT_LIST_MAX;
  const prefs: Preferences = {};
  if (opts.asOf) prefs.asOf = opts.asOf;
  if (opts.budgets) prefs.budgets = opts.budgets;

  const labels = labelsOf(txns);
  const recurring = detectRecurring(txns, labels); // also flips Label.recurring
  const agg = rollups(txns, labels);
  const behaviour = buildBehaviour(txns, labels, recurring, prefs);
  const nudges = select(behaviour, { rank: opts.rank, maxShown: opts.nudgeMax, minP: opts.nudgeMinP });
  const dates = txns.map((t) => t.date).sort();
  const unclassified = labels.filter((l) => l.category === UNCLASSIFIED).length;
  return {
    schema: INSIGHTS_SCHEMA,
    taxonomy: TAXONOMY_URN,
    period: { from: dates[0]!, to: dates[dates.length - 1]! },
    accounts: [...new Set(txns.map((t) => String(t.accountLabel ?? "")))].sort(),
    recordsIn: txns.length,
    ...agg,
    recurring,
    unclassified: { count: unclassified, sharePct: pyRound((100.0 * unclassified) / labels.length, 2) },
    labels: labels.map((l) => ({ txnId: l.txnId, category: l.category, p: l.p, essential: l.essential, recurring: l.recurring })),
    lists: buildLists(txns, labels, listMax),
    behaviour,
    nudges,
    decider: opts.decider ?? { backend: "device-derived", version: "1" },
  };
}
