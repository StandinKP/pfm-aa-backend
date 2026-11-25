/**
 * Nudges — port of pfm-tee-kit/pfm/nudges.py + nudge_catalogue.py. Deterministic
 * triggers propose candidates from `behaviour`; the default selection is the
 * kit's severity-order fallback (no model call, nothing leaves the device).
 *
 * A ranker can still be injected (`rank`): it receives the candidates and
 * returns per-candidate probabilities, and the SAME code path the kit uses for
 * a model decider applies (uniform-preference check, ranking, min_p cut-off).
 */
import { pyRound } from "./num";
import type { Behaviour } from "./behaviour";

export const CATALOGUE_VERSION = "1";
export const CATALOGUE_URN = `urn:sahamati:pfm-nudges:${CATALOGUE_VERSION}`;

export const CATALOGUE: Record<string, { kind: "awareness" | "comparison"; criteria: string; template: string }> = {
  budget_breached: { kind: "comparison", criteria: "a spend category has already gone past its monthly budget with days still left", template: "{category} is at {usedPct}% of the budget you set ({budget}), with {daysRemaining} days left in the month." },
  budget_watch: { kind: "comparison", criteria: "a spend category is close to its monthly budget and will pass it at the current pace", template: "{category} has used {usedPct}% of the budget you set ({budget}) and is on course for {projectedPct}% by month end." },
  category_spike: { kind: "comparison", criteria: "one spend category is running far above its usual monthly level", template: "{category} is running {deltaPct}% above your usual {baseline} a month." },
  subscription_creep: { kind: "awareness", criteria: "recurring subscriptions have grown and a new one started recently", template: "{count} subscriptions now total {monthlyTotal} a month; {newCount} started in the last {windowDays} days." },
  recurring_due_vs_balance: { kind: "comparison", criteria: "recurring payments still due this month are large against the current balance", template: "{dueTotal} of recurring payments fall due by {monthEnd}; your balance today is {balance}." },
  unusual_debit: { kind: "awareness", criteria: "a single debit was far larger than usual for the same payee", template: "A {category} debit of {amount} on {date} was {ratio}x your usual {typicalAmount} there." },
  savings_rate_drop: { kind: "comparison", criteria: "this month's savings rate is tracking well below the previous months", template: "Savings rate is tracking at {currentPct}% this month, against {priorPct}% in earlier months." },
  cash_cushion_high: { kind: "awareness", criteria: "the balance is well above the usual month-end level", template: "Your balance is {balance}, about {multiple}x your usual month-end level of {typical}." },
};

const UNIFORM_EPS = 0.05;
const LEVEL_IDS: ReadonlySet<string> = new Set(["budget_breached", "budget_watch", "category_spike"]);
const MONEY: ReadonlySet<string> = new Set(["budget", "baseline", "monthlyTotal", "dueTotal", "balance", "amount", "typicalAmount", "typical"]);

export interface Candidate {
  id: string;
  severity: number;
  values: Record<string, string | number | null>;
  /** Banded one-liner (kept for a ranker that wants a de-identified description). */
  fact: string;
  p: number | null;
  extra: Record<string, unknown>;
}

export interface RankResult {
  /** candidate id -> probability of being the one to show first. */
  probs: Record<string, number>;
  /** P(worth the customer's attention today), when the ranker has one. */
  actToday?: number | null;
}
export type Ranker = (candidates: readonly Candidate[], behaviour: Behaviour) => RankResult | undefined;

export interface NudgeSelection {
  schema: string;
  catalogueVersion: string;
  asOf: string;
  candidates: Array<{ id: string; severity: number; p: number | null }>;
  selected: Array<Record<string, unknown>>;
  selection: "none" | "severity" | "model";
  actToday: boolean | null;
  pActToday: number | null;
}

/** INR with Indian digit grouping: 1234567 -> "INR 12,34,567". */
export function inr(x: number): string {
  const n = pyRound(Math.abs(x), 0);
  let s = String(n);
  if (s.length > 3) {
    let head = s.slice(0, -3);
    const tail = s.slice(-3);
    const parts: string[] = [];
    while (head.length > 2) {
      parts.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) parts.unshift(head);
    s = parts.join(",") + "," + tail;
  }
  return (x < 0 ? "-" : "") + "INR " + s;
}

const BANDS: Array<[number, string]> = [[500, "under 500"], [2000, "500 to 2,000"], [10000, "2,000 to 10,000"], [50000, "10,000 to 50,000"], [Infinity, "over 50,000"]];
const band = (x: number): string => "INR " + (BANDS.find(([limit]) => Math.abs(x) < limit) ?? BANDS[BANDS.length - 1]!)[1];

const rnd = (x: number, nd = 0): number => pyRound(x, nd);

export function trigger(b: Behaviour): Candidate[] {
  const out: Candidate[] = [];
  const mk = (id: string, severity: number, values: Candidate["values"], fact: string, extra: Record<string, unknown> = {}) =>
    out.push({ id, severity, values, fact, p: null, extra });
  const daysLeft = b.cashflow.daysRemaining;

  const breached = b.budgets.filter((x) => x.status === "breached" && x.source === "customer");
  if (breached.length) {
    const x = breached[0]!;
    mk("budget_breached", Math.min(1.0, 0.6 + (x.usedPct - 100.0) / 100.0),
      { category: x.category, usedPct: rnd(x.usedPct), budget: x.budget, daysRemaining: daysLeft },
      `${x.category} already past its monthly budget (${band(x.budget)}), ${daysLeft} days left`);
  }
  const watch = b.budgets.filter((x) => x.status === "watch" && x.projectedPct >= 100.0 && x.source === "customer");
  if (watch.length && daysLeft >= 3) {
    const x = watch[0]!;
    mk("budget_watch", 0.4, { category: x.category, usedPct: rnd(x.usedPct), budget: x.budget, projectedPct: rnd(x.projectedPct) },
      `${x.category} at ${rnd(x.usedPct)}% of its budget (${band(x.budget)}) with ${daysLeft} days to go`);
  }
  const spikes = b.categoryTrends.filter((t) => t.notable && t.deltaPct !== null && t.deltaPct > 0);
  if (spikes.length) {
    const t = spikes[0]!;
    mk("category_spike", 0.3 + Math.min(0.5, t.deltaPct! / 200.0), { category: t.category, deltaPct: rnd(t.deltaPct!), baseline: t.baseline },
      `${t.category} running ${rnd(t.deltaPct!)}% above its usual level (${band(t.baseline!)} a month)`);
  }
  const subs = b.subscriptions;
  if (subs.newCount >= 1 || subs.count >= 3) {
    mk("subscription_creep", subs.newCount ? 0.35 : 0.3,
      { count: subs.count, monthlyTotal: subs.monthlyTotal, newCount: subs.newCount, windowDays: subs.windowDays },
      `${subs.count} subscriptions totalling ${band(subs.monthlyTotal)} a month, ${subs.newCount} new`);
  }
  const cf = b.cashflow;
  if (cf.recurringDueTotal > 0 && cf.balanceLatest !== null) {
    const sev = cf.recurringDueTotal > cf.balanceLatest ? 0.9 : cf.coverage !== null && cf.coverage < 1.2 ? 0.6 : null;
    if (sev !== null) {
      mk("recurring_due_vs_balance", sev, { dueTotal: cf.recurringDueTotal, monthEnd: cf.monthEnd, balance: cf.balanceLatest },
        `recurring payments of ${band(cf.recurringDueTotal)} due by month end against a balance of ${band(cf.balanceLatest)}`);
    }
  }
  if (b.anomalies.length) {
    const a = b.anomalies[0]!;
    mk("unusual_debit", 0.3 + Math.min(0.4, a.ratio / 10.0),
      { category: a.category, amount: a.amount, date: a.date, ratio: rnd(a.ratio, 1), typicalAmount: a.typicalAmount },
      `one ${a.category} debit of ${band(a.amount)} was ${rnd(a.ratio, 1)}x the usual amount for that payee`, { txnId: a.txnId });
  }
  const sv = b.savings;
  if (sv.dropPoints !== null && sv.dropPoints >= 10.0) {
    mk("savings_rate_drop", 0.4, { currentPct: rnd(sv.currentProjectedPct!), priorPct: rnd(sv.priorAveragePct!) },
      `savings rate tracking ${rnd(sv.dropPoints)} points below earlier months`);
  }
  if (cf.cushionMultiple !== null && cf.cushionMultiple >= 2.0 && cf.balanceLatest !== null) {
    mk("cash_cushion_high", 0.2, { balance: cf.balanceLatest, multiple: rnd(cf.cushionMultiple, 1), typical: cf.typicalMonthEndBalance },
      `balance about ${rnd(cf.cushionMultiple, 1)}x the usual month-end level`);
  }

  out.sort((a, b2) => b2.severity - a.severity);
  // One LEVEL observation per category; an unusual single debit is never merged.
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of out) {
    const category = LEVEL_IDS.has(c.id) ? (c.values["category"] as string | undefined) : undefined;
    if (category && seen.has(category)) continue;
    if (category) seen.add(category);
    deduped.push(c);
  }
  return deduped;
}

const fmt = (key: string, value: string | number | null): string => (MONEY.has(key) ? inr(Number(value)) : String(value));

export function render(c: Candidate): Record<string, unknown> {
  const entry = CATALOGUE[c.id]!;
  let text = entry.template.replace(/\{(\w+)\}/g, (_m, k: string) => fmt(k, c.values[k] ?? null));
  text = text.slice(0, 1).toUpperCase() + text.slice(1);
  return { id: c.id, kind: entry.kind, templateId: `${c.id}:${CATALOGUE_VERSION}`, text, values: c.values, p: c.p, severity: pyRound(c.severity, 3), ...c.extra };
}

export function select(b: Behaviour, opts: { rank?: Ranker; maxShown?: number; minP?: number } = {}): NudgeSelection {
  const maxShown = opts.maxShown ?? 2, minP = opts.minP ?? 0.2;
  const candidates = trigger(b);
  const result: NudgeSelection = { schema: CATALOGUE_URN, catalogueVersion: CATALOGUE_VERSION, asOf: b.asOf, candidates: [], selected: [], selection: "none", actToday: null, pActToday: null };
  if (!candidates.length) return result;

  let method: "severity" | "model" = "severity";
  let probs: Record<string, number> | null = null;
  let act: number | null = null;
  const ranked0 = opts.rank?.(candidates, b);
  if (ranked0) {
    probs = Object.fromEntries(candidates.map((c) => [c.id, Number(ranked0.probs[c.id] ?? 0)]));
    act = ranked0.actToday ?? null;
    const v = Object.values(probs);
    if (Math.max(...v) - Math.min(...v) >= UNIFORM_EPS || candidates.length === 1) method = "model";
    else probs = null;
  }
  let ranked: Candidate[];
  let shown: Candidate[];
  if (probs !== null) {
    for (const c of candidates) c.p = pyRound(probs[c.id]!, 4);
    ranked = [...candidates].sort((a, c2) => (c2.p ?? 0) - (a.p ?? 0) || c2.severity - a.severity);
    shown = ranked.filter((c, i) => i === 0 || (c.p ?? 0) >= minP).slice(0, maxShown);
  } else {
    ranked = candidates;
    shown = candidates.slice(0, maxShown);
  }
  result.selection = method;
  result.actToday = act !== null ? act >= 0.5 : null;
  result.pActToday = act !== null ? pyRound(act, 4) : null;
  result.candidates = ranked.map((c) => ({ id: c.id, severity: pyRound(c.severity, 3), p: c.p }));
  result.selected = shown.map(render);
  return result;
}
