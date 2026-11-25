/**
 * Behavioural signals — port of pfm-tee-kit/pfm/behaviour.py. Deterministic
 * arithmetic over the labelled ledger; the thresholds are the kit's constants
 * (PFM-DESIGN § 12) and must change together with it.
 */
import { INCOME, NON_SPEND_OUTFLOWS, type Label, type Recurring } from "./aggregate";
import { dayNumber, daysInMonth, mean, median, monthOf, parseDate, r2, sum } from "./num";
import { keyString, recordKey } from "./normalise";
import { CATEGORY_IDS, UNCLASSIFIED } from "./taxonomy";
import type { LedgerTxn } from "./types";

export const TREND_MIN_PCT = 25.0;
export const TREND_MIN_AMOUNT = 500.0;
export const BUDGET_WATCH_PCT = 80.0;
export const ANOMALY_RATIO = 2.5;
export const ANOMALY_MIN_OCCURRENCES = 3;
export const ANOMALY_MAX = 5;
export const SUBSCRIPTION_MAX_AMOUNT = 5000.0;
export const SUBSCRIPTION_CATEGORIES: ReadonlySet<string> = new Set(["entertainment", "shopping", "health", "education", "other"]);
export const NEW_RECURRING_WINDOW_DAYS = 45;
export const WEEKS_PER_MONTH = 4.33;
export const SPEND_CATEGORIES: ReadonlySet<string> = new Set(
  CATEGORY_IDS.filter((c) => !NON_SPEND_OUTFLOWS.has(c) && !INCOME.has(c) && c !== "refund"),
);

export interface Preferences {
  budgets?: Record<string, number>;
  /** YYYY-MM-DD reference date; honoured only within [latest, latest + 31 d]. */
  asOf?: string;
}

type SpendMC = Map<string, Map<string, number>>;

export interface Behaviour {
  asOf: string;
  month: string;
  dayOfMonth: number;
  daysInMonth: number;
  priorMonths: string[];
  basis: string;
  categoryTrends: CategoryTrend[];
  budgets: BudgetRow[];
  subscriptions: Subscriptions;
  commitments: Record<string, unknown>;
  anomalies: Anomaly[];
  cashflow: Cashflow;
  savings: Savings;
}
export interface CategoryTrend { category: string; monthToDate: number; projected: number; baseline: number | null; deltaPct: number | null; notable: boolean; note?: string | null }
export interface BudgetRow { category: string; budget: number; source: "customer" | "derived"; spent: number; usedPct: number; projectedPct: number; status: "ok" | "watch" | "breached" }
export interface Subscriptions { count: number; monthlyTotal: number; newCount: number; windowDays: number; items: Array<Record<string, unknown>> }
export interface Anomaly { txnId: string; date: string; category: string; narration: string; amount: number; typicalAmount: number; ratio: number }
export interface Cashflow {
  spendMonthToDate: number; incomeMonthToDate: number; runRatePerDay: number; projectedRemainingSpend: number; projectedMonthSpend: number;
  recurringDue: Array<{ narration: string; category: string; amount: number; expected: string }>; recurringDueTotal: number;
  monthEnd: string; daysRemaining: number; balanceLatest: number | null; balanceByAccount: Record<string, number>;
  coverage: number | null; typicalMonthEndBalance: number | null; cushionMultiple: number | null;
}
export interface Savings { priorMonths: Array<{ month: string; ratePct: number | null }>; priorAveragePct: number | null; currentProjectedPct: number | null; dropPoints: number | null }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveAsOf(txns: readonly LedgerTxn[], prefs?: Preferences): string {
  let latest = txns[0]!.date.slice(0, 10);
  for (const t of txns) if (t.date.slice(0, 10) > latest) latest = t.date.slice(0, 10);
  const wanted = prefs?.asOf;
  if (typeof wanted === "string" && ISO_DATE.test(wanted.slice(0, 10))) {
    try {
      parseDate(wanted.slice(0, 10));
      const w = dayNumber(wanted.slice(0, 10));
      if (dayNumber(latest) <= w && w <= dayNumber(latest) + 31) return wanted.slice(0, 10);
    } catch {
      /* invalid date: ignore, as the kit does */
    }
  }
  return latest;
}

export function customerBudgets(prefs?: Preferences): Record<string, number> {
  const out: Record<string, number> = {};
  const raw = prefs?.budgets;
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) if (SPEND_CATEGORIES.has(k) && typeof v === "number" && v > 0) out[k] = v;
  return out;
}

function spendByMonthCategory(txns: readonly LedgerTxn[], labels: readonly Label[]): SpendMC {
  const out: SpendMC = new Map();
  txns.forEach((r, i) => {
    const l = labels[i]!;
    if (r.amount < 0 && !NON_SPEND_OUTFLOWS.has(l.category) && l.category !== UNCLASSIFIED) {
      const m = out.get(monthOf(r.date)) ?? new Map<string, number>();
      out.set(monthOf(r.date), m);
      m.set(l.category, (m.get(l.category) ?? 0) + -r.amount);
    }
  });
  return out;
}

function incomeByMonth(txns: readonly LedgerTxn[], labels: readonly Label[]): Map<string, number> {
  const out = new Map<string, number>();
  txns.forEach((r, i) => {
    if (r.amount > 0 && INCOME.has(labels[i]!.category)) out.set(monthOf(r.date), (out.get(monthOf(r.date)) ?? 0) + r.amount);
  });
  return out;
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const cat = (mc: SpendMC, m: string, c: string): number => mc.get(m)?.get(c) ?? 0;
const monthTotal = (mc: SpendMC, m: string): number => sum(mc.get(m)?.values() ?? []);

export function categoryTrends(mc: SpendMC, current: string, prior: string[], prorate: number): CategoryTrend[] {
  const cats = new Set<string>();
  for (const m of mc.values()) for (const c of m.keys()) cats.add(c);
  const rows: CategoryTrend[] = [];
  for (const c of sorted(cats)) {
    const baseline = prior.length ? mean(prior.map((m) => cat(mc, m, c))) : null;
    const mtd = cat(mc, current, c);
    const projected = mtd * prorate;
    const row: CategoryTrend = { category: c, monthToDate: r2(mtd), projected: r2(projected), baseline: baseline !== null ? r2(baseline) : null, deltaPct: null, notable: false };
    if (baseline === null) {
      row.deltaPct = null;
      row.notable = false;
    } else if (baseline <= 0) {
      row.deltaPct = null;
      row.notable = projected >= TREND_MIN_AMOUNT;
      row.note = row.notable ? "new this month" : null;
    } else {
      const d = (100.0 * (projected - baseline)) / baseline;
      row.deltaPct = r2(d);
      row.notable = d >= TREND_MIN_PCT && projected - baseline >= TREND_MIN_AMOUNT;
    }
    rows.push(row);
  }
  rows.sort((a, b) => (b.deltaPct !== null ? Math.abs(b.deltaPct) : 0) - (a.deltaPct !== null ? Math.abs(a.deltaPct) : 0));
  return rows;
}

export function budgetStatus(mc: SpendMC, current: string, prior: string[], explicit: Record<string, number>, prorate: number): BudgetRow[] {
  const rows: BudgetRow[] = [];
  const cats = new Set(Object.keys(explicit));
  if (prior.length) for (const m of prior) for (const c of mc.get(m)?.keys() ?? []) cats.add(c);
  for (const c of sorted(cats)) {
    let budget: number;
    let source: "customer" | "derived";
    if (c in explicit) {
      budget = explicit[c]!;
      source = "customer";
    } else {
      const baseline = mean(prior.map((m) => cat(mc, m, c)));
      if (baseline <= 0) continue;
      budget = baseline;
      source = "derived";
    }
    const spent = cat(mc, current, c);
    const used = (100.0 * spent) / budget;
    const status = used >= 100.0 ? "breached" : used >= BUDGET_WATCH_PCT ? "watch" : "ok";
    rows.push({ category: c, budget: r2(budget), source, spent: r2(spent), usedPct: r2(used), projectedPct: r2((100.0 * spent * prorate) / budget), status });
  }
  rows.sort((a, b) => b.usedPct - a.usedPct);
  return rows;
}

interface RecKey { narration: string; mode: string; category: string; first: string; last: string; amounts: number[] }

function recurringKeys(txns: readonly LedgerTxn[], labels: readonly Label[]): Map<string, RecKey> {
  const keys = new Map<string, RecKey>();
  txns.forEach((r, i) => {
    const l = labels[i]!;
    if (!l.recurring || r.amount >= 0) return;
    const k = recordKey(r);
    const d = r.date.slice(0, 10);
    const row = keys.get(keyString(k)) ?? { narration: k[2], mode: k[1], category: l.category, first: d, last: d, amounts: [] };
    keys.set(keyString(k), row);
    if (d < row.first) row.first = d;
    if (d > row.last) row.last = d;
    row.amounts.push(-r.amount);
  });
  return keys;
}

export function subscriptions(txns: readonly LedgerTxn[], labels: readonly Label[], recurring: readonly Recurring[], asOf: string): Subscriptions {
  const cadence = new Map(recurring.map((x) => [`${x.mode}\u0000${x.narration}`, x.cadence]));
  const items: Array<{ narration: string; category: string; cadence: string; amount: number; monthlyEquivalent: number; firstSeen: string; new: boolean }> = [];
  for (const row of recurringKeys(txns, labels).values()) {
    const med = median(row.amounts);
    if (!SUBSCRIPTION_CATEGORIES.has(row.category) || med > SUBSCRIPTION_MAX_AMOUNT) continue;
    const cad = cadence.get(`${row.mode}\u0000${row.narration}`) ?? "monthly";
    const monthly = med * (cad === "weekly" ? WEEKS_PER_MONTH : 1.0);
    items.push({
      narration: row.narration, category: row.category, cadence: cad, amount: r2(med), monthlyEquivalent: r2(monthly), firstSeen: row.first,
      new: dayNumber(asOf) - dayNumber(row.first) <= NEW_RECURRING_WINDOW_DAYS,
    });
  }
  items.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
  return {
    count: items.length, monthlyTotal: r2(sum(items.map((x) => x.monthlyEquivalent))), newCount: items.filter((x) => x.new).length,
    windowDays: NEW_RECURRING_WINDOW_DAYS, items,
  };
}

const monthlyOf = (x: Recurring): number => x.medianAmount * (x.cadence === "weekly" ? WEEKS_PER_MONTH : 1.0);

export function commitments(recurring: readonly Recurring[], income: Map<string, number>, prior: string[]) {
  const monthly = sum(recurring.map(monthlyOf));
  const avgIncome = prior.length ? mean(prior.map((m) => income.get(m) ?? 0)) : 0.0;
  const byCat = new Map<string, number>();
  for (const x of recurring) byCat.set(x.category, (byCat.get(x.category) ?? 0) + monthlyOf(x));
  return {
    monthlyTotal: r2(monthly), count: recurring.length,
    shareOfIncomePct: avgIncome > 0 ? r2((100.0 * monthly) / avgIncome) : null,
    byCategory: [...byCat].map(([category, t]) => ({ category, monthlyTotal: r2(t) })).sort((a, b) => b.monthlyTotal - a.monthlyTotal),
  };
}

export function anomalies(txns: readonly LedgerTxn[], labels: readonly Label[]): Anomaly[] {
  const groups = new Map<string, { key: [string, string, string]; items: Array<{ a: number; i: number }> }>();
  txns.forEach((r, i) => {
    if (r.amount < 0) {
      const key = recordKey(r);
      const g = groups.get(keyString(key)) ?? { key, items: [] };
      g.items.push({ a: -r.amount, i });
      groups.set(keyString(key), g);
    }
  });
  const found: Anomaly[] = [];
  for (const { key, items } of groups.values()) {
    if (items.length < ANOMALY_MIN_OCCURRENCES) continue;
    const med = median(items.map((x) => x.a));
    if (med <= 0) continue;
    for (const { a, i } of items) {
      if (a >= ANOMALY_RATIO * med) {
        found.push({ txnId: labels[i]!.txnId, date: txns[i]!.date, category: labels[i]!.category, narration: key[2], amount: r2(a), typicalAmount: r2(med), ratio: r2(a / med) });
      }
    }
  }
  found.sort((a, b) => b.ratio - a.ratio);
  return found.slice(0, ANOMALY_MAX);
}

/** Latest balance per account by (date, timestamp); only rows that carry a numeric balance. */
function latestPerAccount(rows: readonly LedgerTxn[]): Map<string, number> {
  const per = new Map<string, { date: string; ts: string; v: number }>();
  for (const r of rows) {
    if (typeof r.balance !== "number") continue;
    const date = String(r.date), ts = String(r.timestamp ?? ""), acc = String(r.accountLabel ?? "");
    const cur = per.get(acc);
    if (!cur || date > cur.date || (date === cur.date && ts > cur.ts)) per.set(acc, { date, ts, v: r.balance });
  }
  return new Map([...per].map(([a, x]) => [a, x.v]));
}

function latestBalances(txns: readonly LedgerTxn[]): { total: number | null; byAccount: Record<string, number> } {
  const per = latestPerAccount(txns);
  if (!per.size) return { total: null, byAccount: {} };
  return { total: r2(sum(per.values())), byAccount: Object.fromEntries([...per].map(([a, v]) => [a, r2(v)])) };
}

function monthEndBalances(txns: readonly LedgerTxn[], prior: string[]): number[] {
  const out: number[] = [];
  for (const m of prior) {
    const per = latestPerAccount(txns.filter((r) => monthOf(r.date) === m && typeof r.balance === "number"));
    if (per.size) out.push(sum(per.values()));
  }
  return out;
}

export function cashflow(txns: readonly LedgerTxn[], mc: SpendMC, income: Map<string, number>, recurring: readonly Recurring[], asOf: string, current: string, prior: string[]): Cashflow {
  const { y, m, d: day } = parseDate(asOf);
  const dim = daysInMonth(y, m);
  const remaining = dim - day;
  const mtd = monthTotal(mc, current);
  const runRate = day ? mtd / day : 0.0;
  const projectedRemaining = runRate * remaining;
  const end = `${asOf.slice(0, 7)}-${String(dim).padStart(2, "0")}`;
  const due = recurring
    .filter((x) => dayNumber(asOf) < dayNumber(x.nextExpected) && dayNumber(x.nextExpected) <= dayNumber(end))
    .map((x) => ({ narration: x.narration, category: x.category, amount: x.medianAmount, expected: x.nextExpected }));
  const dueTotal = sum(due.map((x) => x.amount));
  const { total: balance, byAccount } = latestBalances(txns);
  const usual = monthEndBalances(txns, prior);
  const typicalEnd = usual.length ? r2(median(usual)) : null;
  const need = projectedRemaining + dueTotal;
  due.sort((a, b) => (a.expected < b.expected ? -1 : a.expected > b.expected ? 1 : 0));
  return {
    spendMonthToDate: r2(mtd), incomeMonthToDate: r2(income.get(current) ?? 0.0), runRatePerDay: r2(runRate),
    projectedRemainingSpend: r2(projectedRemaining), projectedMonthSpend: r2(mtd + projectedRemaining),
    recurringDue: due, recurringDueTotal: r2(dueTotal), monthEnd: end, daysRemaining: remaining,
    balanceLatest: balance, balanceByAccount: byAccount,
    coverage: balance !== null && need > 0 ? r2(balance / need) : null,
    typicalMonthEndBalance: typicalEnd,
    cushionMultiple: balance !== null && typicalEnd && typicalEnd > 0 ? r2(balance / typicalEnd) : null,
  };
}

export function savings(mc: SpendMC, income: Map<string, number>, current: string, prior: string[], prorate: number): Savings {
  const rows = prior.map((m) => {
    const inc = income.get(m) ?? 0.0, sp = monthTotal(mc, m);
    return { month: m, ratePct: inc > 0 ? r2((100.0 * (inc - sp)) / inc) : null };
  });
  const priorRates = rows.map((x) => x.ratePct).filter((x): x is number => x !== null);
  const inc = income.get(current) ?? 0.0, sp = monthTotal(mc, current) * prorate;
  const currentRate = inc > 0 ? r2((100.0 * (inc - sp)) / inc) : null;
  const priorAvg = priorRates.length ? r2(mean(priorRates)) : null;
  return {
    priorMonths: rows, priorAveragePct: priorAvg, currentProjectedPct: currentRate,
    dropPoints: priorAvg !== null && currentRate !== null ? r2(priorAvg - currentRate) : null,
  };
}

export function buildBehaviour(txns: readonly LedgerTxn[], labels: readonly Label[], recurring: readonly Recurring[], prefs?: Preferences): Behaviour {
  const asOf = resolveAsOf(txns, prefs);
  const { y, m, d } = parseDate(asOf);
  const current = asOf.slice(0, 7);
  const dim = daysInMonth(y, m);
  const mc = spendByMonthCategory(txns, labels);
  const income = incomeByMonth(txns, labels);
  const months = sorted(new Set([...txns.map((r) => monthOf(r.date)), current]));
  const prior = months.filter((x) => x < current);
  const prorate = dim / d;
  return {
    asOf, month: current, dayOfMonth: d, daysInMonth: dim, priorMonths: prior,
    basis: "current month pro-rated to a full month by elapsed days; prior months taken as complete",
    categoryTrends: categoryTrends(mc, current, prior, prorate),
    budgets: budgetStatus(mc, current, prior, customerBudgets(prefs), prorate),
    subscriptions: subscriptions(txns, labels, recurring, asOf),
    commitments: commitments(recurring, income, prior),
    anomalies: anomalies(txns, labels),
    cashflow: cashflow(txns, mc, income, recurring, asOf, current, prior),
    savings: savings(mc, income, current, prior, prorate),
  };
}
