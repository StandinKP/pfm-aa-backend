/**
 * Deterministic insights arithmetic — port of pfm-tee-kit/pfm/aggregate.py.
 * No model, no I/O. Input order matters for tie-breaks (the kit's record
 * order): callers keep the ledger in (date, arrival) order.
 *
 *   spend     = outflows excluding `transfer` and `investment`
 *   income    = credits in salary + interest
 *   recurring = a debit key seen >= 2 times, monthly (26-35 d) or weekly (6-8 d)
 *               median gap, amounts within +-30 % of the median
 */
import { dayNumber, isoFromDayNumber, median, monthOf, r2 } from "./num";
import { keyString, normaliseNarration, recordKey } from "./normalise";
import type { LedgerTxn } from "./types";

export const NON_SPEND_OUTFLOWS: ReadonlySet<string> = new Set(["transfer", "investment"]);
export const INCOME: ReadonlySet<string> = new Set(["salary", "interest"]);

/** A transaction's label as the kit's `Label`; `recurring` is set by detectRecurring. */
export interface Label {
  txnId: string;
  category: string;
  p: number;
  essential: boolean;
  recurring: boolean;
}

export const labelsOf = (txns: readonly LedgerTxn[]): Label[] =>
  txns.map((t) => ({ txnId: t.txnId, category: t.category, p: t.p, essential: t.essential, recurring: false }));

export interface Recurring {
  narration: string;
  mode: string;
  category: string;
  cadence: "monthly" | "weekly";
  occurrences: number;
  medianAmount: number;
  lastDate: string;
  nextExpected: string;
}

export function detectRecurring(recs: readonly LedgerTxn[], labels: Label[]): Recurring[] {
  const groups = new Map<string, { key: [string, string, string]; items: Array<{ date: string; amt: number; i: number }> }>();
  recs.forEach((r, i) => {
    if (r.amount < 0) {
      const key = recordKey(r);
      const g = groups.get(keyString(key)) ?? { key, items: [] };
      g.items.push({ date: r.date.slice(0, 10), amt: Math.abs(r.amount), i });
      groups.set(keyString(key), g);
    }
  });
  const found: Recurring[] = [];
  for (const { key, items } of groups.values()) {
    if (items.length < 2) continue;
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.amt - b.amt || a.i - b.i));
    const gaps = items.slice(1).map((b, k) => dayNumber(b.date) - dayNumber(items[k]!.date));
    const g = median(gaps);
    const cadence = g >= 26 && g <= 35 ? "monthly" : g >= 6 && g <= 8 ? "weekly" : null;
    const amounts = items.map((x) => x.amt);
    const m = median(amounts);
    if (cadence === null || m <= 0 || amounts.some((a) => Math.abs(a - m) > 0.3 * m)) continue;
    for (const x of items) labels[x.i]!.recurring = true;
    const last = items[items.length - 1]!.date;
    const step = cadence === "monthly" ? 30 : 7;
    found.push({
      narration: key[2], mode: key[1], category: labels[items[items.length - 1]!.i]!.category, cadence,
      occurrences: items.length, medianAmount: r2(m), lastDate: last, nextExpected: isoFromDayNumber(dayNumber(last) + step),
    });
  }
  found.sort((a, b) => b.medianAmount - a.medianAmount);
  return found;
}

const bump = (m: Map<string, { total: number; count: number }>, k: string, v: number) => {
  const e = m.get(k) ?? { total: 0, count: 0 };
  e.total += v;
  e.count += 1;
  m.set(k, e);
};

export function rollups(recs: readonly LedgerTxn[], labels: readonly Label[]) {
  const out = new Map<string, { total: number; count: number }>();
  const inn = new Map<string, { total: number; count: number }>();
  type M = { spend: number; outflows: number; income: number; otherInflows: number; count: number };
  const months = new Map<string, M>();
  let spend = 0, outflows = 0, income = 0, otherIn = 0, essential = 0;
  recs.forEach((r, i) => {
    const l = labels[i]!;
    const month = monthOf(r.date);
    const mm = months.get(month) ?? { spend: 0, outflows: 0, income: 0, otherInflows: 0, count: 0 };
    months.set(month, mm);
    mm.count += 1;
    if (r.amount < 0) {
      const a = -r.amount;
      bump(out, l.category, a);
      outflows += a;
      mm.outflows += a;
      if (!NON_SPEND_OUTFLOWS.has(l.category)) {
        spend += a;
        mm.spend += a;
        if (l.essential) essential += a;
      }
    } else {
      bump(inn, l.category, r.amount);
      if (INCOME.has(l.category)) {
        income += r.amount;
        mm.income += r.amount;
      } else {
        otherIn += r.amount;
        mm.otherInflows += r.amount;
      }
    }
  });

  const monthRows: Array<Record<string, number | string>> = [];
  let prev: string | null = null;
  for (const m of [...months.keys()].sort()) {
    const v = months.get(m)!;
    const row: Record<string, number | string> = {
      month: m, spend: r2(v.spend), outflows: r2(v.outflows), income: r2(v.income), otherInflows: r2(v.otherInflows),
      count: v.count, net: r2(v.income - v.spend),
    };
    if (prev !== null && months.get(prev)!.spend > 0) {
      const delta = v.spend - months.get(prev)!.spend;
      row["spendDelta"] = r2(delta);
      row["spendDeltaPct"] = r2((100.0 * delta) / months.get(prev)!.spend);
    }
    prev = m;
    monthRows.push(row);
  }

  const cats = [...out].map(([category, v]) => ({
    category, total: r2(v.total), count: v.count,
    sharePct: spend > 0 && !NON_SPEND_OUTFLOWS.has(category) ? r2((100.0 * v.total) / spend) : null,
  }));
  cats.sort((a, b) => b.total - a.total);
  const inflows = [...inn].map(([category, v]) => ({ category, total: r2(v.total), count: v.count }));
  inflows.sort((a, b) => b.total - a.total);

  return {
    outflowsByCategory: cats,
    inflowsByCategory: inflows,
    months: monthRows,
    totals: {
      spend: r2(spend), outflows: r2(outflows), income: r2(income), otherInflows: r2(otherIn), essentialSpend: r2(essential),
      essentialSharePct: spend > 0 ? r2((100.0 * essential) / spend) : null,
      savingsRatePct: income > 0 ? r2((100.0 * (income - spend)) / income) : null,
    },
    topCategories: cats.filter((c) => !NON_SPEND_OUTFLOWS.has(c.category)).map((c) => c.category).slice(0, 5),
  };
}

export interface ListRow {
  txnId: string; date: string; amount: number; mode: string; narration: string; accountLabel: string; recurring: boolean;
}

export function buildLists(recs: readonly LedgerTxn[], labels: readonly Label[], listMax: number): Record<string, ListRow[]> {
  const lists = new Map<string, ListRow[]>();
  recs.forEach((r, i) => {
    const l = labels[i]!;
    const rows = lists.get(l.category) ?? [];
    rows.push({
      txnId: l.txnId, date: r.date, amount: r2(r.amount), mode: String(r.mode ?? ""), narration: normaliseNarration(r.narration),
      accountLabel: String(r.accountLabel ?? ""), recurring: l.recurring,
    });
    lists.set(l.category, rows);
  });
  const out: Record<string, ListRow[]> = {};
  for (const [cat, items] of lists) {
    items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.txnId < b.txnId ? 1 : a.txnId > b.txnId ? -1 : 0));
    out[cat] = items.slice(0, listMax);
  }
  return out;
}
