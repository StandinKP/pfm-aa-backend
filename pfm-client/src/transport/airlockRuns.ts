/**
 * Client for the FIU backend's Airlock mode (pfm-fiu-backend: POST /v1/runs,
 * GET /v1/runs/:id). The app never talks to Airlock and holds no Airlock secret:
 * the backend runs the whole flow as the FIU's system and returns the opened
 * reply plus an evidence summary. No VP, no replyTo — those belong to the
 * queue/relay path. Runs are asynchronous (≈45 s, or longer when a human releases
 * the mock AA data), so this polls and reports stages.
 */
type F = typeof fetch;
const base = (u: string) => u.replace(/\/+$/, "");

export interface Evidence {
  runId: string; environment: string; agentWorkloadId: string; agentDigest: string; consentId: string; startedAt: string;
  receipts: Array<{ type: string; at?: string }>;
  apiVerdict: unknown;
  independentlyVerified: false;
}
export interface RunView {
  status: "running" | "completed" | "failed";
  stage: string;
  runId?: string;
  consentId: string;
  answer?: unknown;
  evidence?: Evidence;
  error?: { type: string; refusals?: Array<[string, string | null]> };
}
export class RunFailedError extends Error {
  constructor(readonly errorType: string, readonly refusals: Array<[string, string | null]> = []) {
    super(refusals.length ? `${errorType}: ${refusals.map((r) => r.join(" ")).join("; ")}` : errorType);
  }
}

async function j<T>(f: F, url: string, init: RequestInit): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`backend returned ${res.status}${await res.json().then((x: { error?: string }) => (x.error ? `: ${x.error}` : ""), () => "")}`);
  return (await res.json()) as T;
}
const auth = (t: string): RequestInit => ({ headers: { authorization: `Bearer ${t}` } });

export async function runViaAirlock(o: {
  baseUrl: string; token: string; consentId?: string; fetchImpl?: F;
  onStage?: (stage: string, runId?: string) => void;
  pollMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<RunView & { id: string }> {
  const f = o.fetchImpl ?? fetch, u = base(o.baseUrl);
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const { id } = await j<{ id: string }>(f, `${u}/v1/runs`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.token}` },
    body: JSON.stringify(o.consentId ? { consentId: o.consentId } : {}),
  });
  const deadline = Date.now() + (o.maxMs ?? 25 * 60_000); // worst case in the handoff is ~20 min
  let last = "";
  for (;;) {
    const v = await j<RunView>(f, `${u}/v1/runs/${id}`, auth(o.token));
    if (v.stage !== last) { last = v.stage; o.onStage?.(v.stage, v.runId); }
    if (v.status === "completed") return { ...v, id };
    if (v.status === "failed") throw new RunFailedError(v.error?.type ?? "Error", v.error?.refusals);
    if (Date.now() > deadline) throw new Error("timed out waiting for the run");
    await sleep(o.pollMs ?? 3_000);
  }
}

/** The chain export as a Blob URL source — the evidence to keep beside the result. */
export async function fetchChain(baseUrl: string, token: string, id: string, f: F = fetch): Promise<string> {
  const res = await f(`${base(baseUrl)}/v1/runs/${id}/chain`, auth(token));
  if (!res.ok) throw new Error(`backend returned ${res.status}`);
  return res.text();
}
