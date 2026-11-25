/**
 * Fetch cadence — the client half of PFM-DESIGN §11. Opening the app NEVER starts a job:
 * it renders the stored ledger. A refresh is a deliberate, budgeted act.
 *
 *   - 30 AA fetches per month per consent; 4 held back for on-demand use
 *   - scheduled-due: every 2 days (at most 1/day), backing off to weekly after two empty increments
 *   - manual refresh: allowed any time there is budget, with a short debounce
 *
 * This is ADVISORY on the device. The authoritative bucket belongs to the FIU backend
 * (it holds the AA credentials); nothing here can raise the real limit.
 */
export const MONTHLY_CAP = 30;
export const RESERVE = 4;
const H = 3_600_000;
export const BASE_GAP_MS = 48 * H;
export const WEEKLY_GAP_MS = 7 * 24 * H;
export const MANUAL_DEBOUNCE_MS = 15 * 60_000;

export interface CadenceState {
  /** YYYY-MM of `fetches`. */
  month: string;
  fetches: number;
  /** Consecutive increments that brought zero new transactions. */
  emptyStreak: number;
  /** ISO timestamp of the last completed fetch. */
  lastFetchAt: string | null;
}

export const emptyCadence = (): CadenceState => ({ month: "", fetches: 0, emptyStreak: 0, lastFetchAt: null });

const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const rolled = (c: CadenceState, now: Date): CadenceState => (c.month === monthOf(now) ? c : { ...c, month: monthOf(now), fetches: 0 });

export interface Decision {
  /** A manual refresh may run now. */
  manualAllowed: boolean;
  /** A scheduled refresh is due (the UI badges it; nothing runs by itself). */
  due: boolean;
  /** Why not, in words for the UI. */
  reason?: string;
  /** When the next scheduled refresh becomes due. */
  nextDueAt: Date | null;
  fetchesLeft: number;
}

export function decide(state: CadenceState, now: Date): Decision {
  const c = rolled(state, now);
  const left = Math.max(0, MONTHLY_CAP - c.fetches);
  const last = c.lastFetchAt ? new Date(c.lastFetchAt) : null;
  const gap = c.emptyStreak >= 2 ? WEEKLY_GAP_MS : BASE_GAP_MS;
  const nextDueAt = last ? new Date(last.getTime() + gap) : null;
  const scheduledOk = c.fetches < MONTHLY_CAP - RESERVE;
  const due = scheduledOk && (nextDueAt === null || nextDueAt <= now);
  if (left === 0) return { manualAllowed: false, due: false, reason: "This month's fetch budget is used up.", nextDueAt, fetchesLeft: 0 };
  if (last && now.getTime() - last.getTime() < MANUAL_DEBOUNCE_MS) {
    return { manualAllowed: false, due, reason: "Refreshed a moment ago.", nextDueAt, fetchesLeft: left };
  }
  return { manualAllowed: true, due, nextDueAt, fetchesLeft: left };
}

/** Record a completed fetch. A fetch that returned nothing new still spends budget. */
export function recordFetch(state: CadenceState, now: Date, newTxns: number): CadenceState {
  const c = rolled(state, now);
  return { month: c.month, fetches: c.fetches + 1, emptyStreak: newTxns === 0 ? c.emptyStreak + 1 : 0, lastFetchAt: now.toISOString() };
}
