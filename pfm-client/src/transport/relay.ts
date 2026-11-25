/**
 * Transport: the FIU backend (PFM-DESIGN §6 / ADR-006 option D) — the production
 * shape. The app authenticates to its own FIU, which holds the queue-requester
 * identity. The job (with the presentation) and the sealed reply pass through
 * the relay unread; the enclave verifies the presentation and only the device
 * can unseal the reply.
 *
 * Auth here is the mock backend's `POST /v1/session`; a real FIU substitutes its
 * own login and passes the resulting bearer token to `token`.
 */
import type { P256PublicJwk } from "../lib/didkey";
import type { CredentialBundle } from "../vc/credentials";
import { CancelledError, ReplyTimeoutError, TransportError, type Job, type OnEvent, type Reply, type SendHooks, type Transport } from "./types";
import { isTransient, sleep, withRetry } from "../lib/retry";

type F = typeof fetch;
const base = (u: string) => u.replace(/\/+$/, "");

/** One HTTP call. `signal` (the app's cancel) is combined with a per-call timeout. */
async function call<T>(f: F, url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 150_000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await f(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw new CancelledError();
    throw e;
  }
  if (!res.ok) {
    const e = await res.json().then((j: { error?: string }) => j.error, () => undefined);
    throw new TransportError(`backend returned ${res.status}${e ? `: ${e}` : ""}`, res.status);
  }
  return (await res.json()) as T;
}

/** Safe-to-repeat call: retried with backoff on network failure / 429 / 5xx. */
const callIdem = <T>(f: F, url: string, init: RequestInit, signal?: AbortSignal) =>
  withRetry(() => call<T>(f, url, init, signal, 20_000), { signal });

const post = (token: string | undefined, body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

export const relayConfig = (url: string, f: F = fetch, signal?: AbortSignal) => callIdem<{ audience: string; mode: string }>(f, `${base(url)}/v1/config`, {}, signal);
export const relayLogin = async (url: string, customerId: string, f: F = fetch, accessKey?: string, signal?: AbortSignal) => {
  const init = post(undefined, { customerId });
  if (accessKey) (init.headers as Record<string, string>)["x-access-key"] = accessKey;
  return (await callIdem<{ token: string }>(f, `${base(url)}/v1/session`, init, signal)).token;
};
export const relayCredentials = (url: string, token: string, holder: { did: string; jwk: P256PublicJwk }, f: F = fetch, signal?: AbortSignal) =>
  callIdem<CredentialBundle>(f, `${base(url)}/v1/credentials`, post(token, { holder }), signal);
/** The last sealed reply the backend stored — opening the app never triggers a fetch. */
export const relayLatest = (url: string, token: string, f: F = fetch, signal?: AbortSignal) =>
  call<{ jobId: string; output: string }>(f, `${base(url)}/v1/insights/latest`, { headers: { authorization: `Bearer ${token}` } }, signal, 20_000);

export function createRelayTransport(o: { baseUrl: string; token: string; fetchImpl?: F; pollIntervalMs?: number; resumeTimeoutMs?: number }): Transport {
  const f = o.fetchImpl ?? fetch;

  /** Poll the backend's stored reply until it is OURS (jobId match). The backend finishes a job even if we hung up. */
  async function resume(jobId: string, onEvent?: OnEvent, hooks?: SendHooks): Promise<Reply> {
    const say = onEvent ?? (() => undefined);
    say("re-attaching: checking the backend for this job's reply");
    const deadline = Date.now() + (o.resumeTimeoutMs ?? 150_000);
    while (Date.now() < deadline) {
      try {
        const s = await relayLatest(o.baseUrl, o.token, f, hooks?.signal);
        if (s.jobId === jobId) {
          await hooks?.beforeAck?.(s.output);
          return { outcome: "ok", output: s.output };
        }
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        if (!(e instanceof TransportError && e.status === 404) && !isTransient(e)) throw e; // 404 = nothing stored yet
      }
      await sleep(o.pollIntervalMs ?? 3_000, hooks?.signal);
    }
    throw new ReplyTimeoutError("the backend has no reply for this job yet");
  }

  return {
    name: `fiu-backend ${base(o.baseUrl)}`,
    async send(job: Job, onEvent?: OnEvent, hooks?: SendHooks): Promise<Reply> {
      onEvent?.("sent to the FIU backend; it relays without reading");
      let reply: Reply;
      try {
        reply = await call<Reply>(f, `${base(o.baseUrl)}/v1/insights`, post(o.token, { jobId: job.jobId, body: job.body }), hooks?.signal);
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        // Dropped connection, timeout, gateway error or "already used": the job may well be running — attach by jobId, never re-send.
        // 429 (in flight / budget used) and other 4xx are answers, not lost connections: do not wait for a reply that will not come.
        const lost = e instanceof TransportError ? e.status === undefined || e.status >= 500 || e.status === 409 : isTransient(e);
        if (lost) {
          onEvent?.("connection lost mid-request; the job is not re-sent");
          return resume(job.jobId, onEvent, hooks);
        }
        throw e;
      }
      if (reply.outcome === "ok") await hooks?.beforeAck?.(reply.output);
      return reply;
    },
    resume,
  };
}
