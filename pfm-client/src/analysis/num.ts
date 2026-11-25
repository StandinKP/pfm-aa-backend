/**
 * Python-parity numerics. The kit's figures come from CPython (`round`,
 * `statistics.mean/median`, `calendar`); these reproduce them so the device
 * derives byte-identical numbers from the same ledger.
 */

/** Python `round(x, nd)`: exact-decimal, ties to even (JS `toFixed` rounds exact ties up). */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const neg = x < 0 || Object.is(x, -0);
  const full = Math.abs(x).toFixed(nd + 40);
  const dot = full.indexOf(".");
  const ip = full.slice(0, dot);
  const fp = full.slice(dot + 1);
  const keep = ip + fp.slice(0, nd);
  const rest = fp.slice(nd);
  let n = BigInt(keep);
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  if (first > 5 || (first === 5 && (tail || n % 2n === 1n))) n += 1n;
  const out = Number(n) / 10 ** nd;
  return neg ? -out : out;
}

/** `_r` in the kit: round(float(x), 2). */
export const r2 = (x: number): number => pyRound(x, 2);

/** Python `statistics.median`. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new RangeError("median of empty data");
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function decompose(x: number): { m: bigint; e: number } {
  if (x === 0) return { m: 0n, e: 0 };
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  return { m: sign * mant, e };
}

/** Python `statistics.mean` for floats: exact sum, one correctly rounded division. */
export function mean(xs: number[]): number {
  const n = xs.length;
  if (n === 0) throw new RangeError("mean of empty data");
  const parts = xs.map(decompose);
  const emin = Math.min(...parts.map((p) => (p.m === 0n ? 0 : p.e)));
  let sum = 0n;
  for (const p of parts) if (p.m !== 0n) sum += p.m << BigInt(p.e - emin);
  if (sum === 0n) return 0;
  const neg = sum < 0n;
  const a = neg ? -sum : sum;
  const shift = 128n;
  const num = a << shift;
  const den = BigInt(n);
  let q = num / den;
  if (num % den !== 0n) q = (q << 1n) | 1n; // sticky bit
  const sticky = num % den !== 0n ? 1 : 0;
  const k = emin - Number(shift) - sticky;
  const half = Math.trunc(k / 2);
  const v = Number(q) * 2 ** half * 2 ** (k - half);
  return neg ? -v : v;
}

/** Naive left-to-right float sum, like CPython < 3.12 `sum()`. */
export const sum = (xs: Iterable<number>): number => {
  let t = 0;
  for (const x of xs) t += x;
  return t;
};

// ---- calendar (UTC, no timezone drift) ---------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

export interface Ymd { y: number; m: number; d: number }

export function parseDate(s: string): Ymd {
  const g = ISO.exec(String(s));
  if (!g) throw new RangeError(`not an ISO date: ${s}`);
  const y = Number(g[1]), m = Number(g[2]), d = Number(g[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new RangeError(`invalid date: ${s}`);
  return { y, m, d };
}

/** Whole days since 1970-01-01 (monotonic day number; differences are calendar days). */
export const dayNumber = (s: string | Ymd): number => {
  const { y, m, d } = typeof s === "string" ? parseDate(s) : s;
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

export const isoFromDayNumber = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const monthOf = (s: string): string => String(s).slice(0, 7);
