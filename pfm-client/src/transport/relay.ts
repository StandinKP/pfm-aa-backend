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
import { TransportError, type Job, type OnEvent, type Reply, type Transport } from "./types";

type F = typeof fetch;
const base = (u: string) => u.replace(/\/+$/, "");

async function call<T>(f: F, url: string, init: RequestInit): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(150_000) });
  if (!res.ok) {
    const e = await res.json().then((j: { error?: string }) => j.error, () => undefined);
    throw new TransportError(`backend returned ${res.status}${e ? `: ${e}` : ""}`);
  }
  return (await res.json()) as T;
}

const post = (token: string | undefined, body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

export const relayConfig = (url: string, f: F = fetch) => call<{ audience: string; mode: string }>(f, `${base(url)}/v1/config`, {});
export const relayLogin = async (url: string, customerId: string, f: F = fetch, accessKey?: string) => {
  const init = post(undefined, { customerId });
  if (accessKey) (init.headers as Record<string, string>)["x-access-key"] = accessKey;
  return (await call<{ token: string }>(f, `${base(url)}/v1/session`, init)).token;
};
export const relayCredentials = (url: string, token: string, holder: { did: string; jwk: P256PublicJwk }, f: F = fetch) =>
  call<CredentialBundle>(f, `${base(url)}/v1/credentials`, post(token, { holder }));
/** The last sealed reply the backend stored — opening the app never triggers a fetch. */
export const relayLatest = (url: string, token: string, f: F = fetch) =>
  call<{ jobId: string; output: string }>(f, `${base(url)}/v1/insights/latest`, { headers: { authorization: `Bearer ${token}` } });

export function createRelayTransport(o: { baseUrl: string; token: string; fetchImpl?: F }): Transport {
  const f = o.fetchImpl ?? fetch;
  return {
    name: `fiu-backend ${base(o.baseUrl)}`,
    async send(job: Job, onEvent?: OnEvent): Promise<Reply> {
      onEvent?.("sent to the FIU backend; it relays without reading");
      return call<Reply>(f, `${base(o.baseUrl)}/v1/insights`, post(o.token, { jobId: job.jobId, body: job.body }));
    },
  };
}
