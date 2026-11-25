/**
 * Bounded retry with exponential backoff + jitter, cancellable. Only for calls that are
 * safe to repeat (GETs, session mint, credential fetch, reply polling) — a job POST is
 * resumed by jobId instead (see Transport.resume), never blindly re-sent.
 */
import { CancelledError, TransportError } from "../transport/types";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Network failure, timeout, 429 or 5xx. 4xx (other than 429) and cancellation are final. */
export function isTransient(e: unknown): boolean {
  if (e instanceof CancelledError) return false;
  if (e instanceof TransportError) return e.status === undefined || e.status === 429 || e.status >= 500;
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) return true;
  return e instanceof TypeError; // fetch network failure
}

export interface RetryOpts {
  tries?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  retryable?: (e: unknown) => boolean;
  /** Test seam. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (attempt: number, e: unknown, delayMs: number) => void;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const tries = o.tries ?? 3;
  const wait = o.wait ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= tries || !(o.retryable ?? isTransient)(e)) throw e;
      const delay = Math.min(o.maxMs ?? 8_000, (o.baseMs ?? 500) * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      o.onRetry?.(attempt, e, delay);
      await wait(delay, o.signal);
    }
  }
}
