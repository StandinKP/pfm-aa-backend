/**
 * One "get my insights" round trip, transport-agnostic:
 *
 *   build job body (replyTo = device reply key, no records, no consent field)
 *   → sign a presentation over it (agent + consent credentials)
 *   → transport.send → reply
 *   → unseal with the device reply key → insights document
 *
 * The app sends NO financial data: the enclave fetches it under the consent the
 * credential proves. The reply is sealed to a key only this device holds, so any
 * relay (queue, FIU backend) sees ciphertext and counts.
 */
import { compactDecrypt } from "jose";
import { fromUtf8 } from "../lib/bytes";
import { didKeyFromP256Jwk } from "../lib/didkey";
import { publicJwk, thumbprint, type DeviceKeys } from "../lib/keys";
import { buildPresentation } from "../vc/present";
import { summarise, type CredentialBundle } from "../vc/credentials";
import type { Job, OnEvent, Reply, SendHooks, Transport } from "../transport/types";
import { ReplyShapeError, checkInsights, parseDelta, type DeltaDoc } from "./validate";

export const JOB_SCHEMA = "urn:sahamati:cs-job:2";
export const REPLY_SCHEMA = "urn:sahamati:pfm-reply:1";

export interface Preferences {
  budgets?: Record<string, number>;
  /** YYYY-MM-DD reference date; the enclave defaults to the latest record. */
  asOf?: string;
}

export interface Insights {
  schema: string;
  period?: { from: string; to: string } | null;
  accounts: string[];
  recordsIn: number;
  totals: { spend: number; income: number; savingsRatePct?: number | null; essentialSharePct?: number | null };
  outflowsByCategory: Array<{ category: string; total: number; count: number; sharePct?: number | null }>;
  months: Array<{ month: string; spend: number; income: number; net: number; spendDeltaPct?: number | null }>;
  nudges?: { selected: Array<{ kind: string; text: string; p?: number | null }> };
  behaviour?: unknown;
  decider?: { backend: string; version: string };
  [k: string]: unknown;
}

export interface InsightsResult {
  jobId: string;
  insights: Insights;
  /** Cleartext counts the relay could see. */
  meta: Record<string, unknown>;
  /** The sealed reply as received — the only form that is ever persisted. */
  sealed: string;
  /** null until the ADR-004 reply-provenance credential is wired into the enclave. */
  provenance: unknown;
}

/**
 * The far side answered a delta job with a FULL insights document: an enclave/backend that predates delta
 * mode ignored the `delta` block. Not an error — the caller shows it as-is and does not touch the ledger.
 */
export class LegacyReply extends Error {
  override name = "LegacyReply";
  constructor(readonly insights: Insights) {
    super("enclave answered with a full document");
  }
}

export class PfmRequestError extends Error {
  override name = "PfmRequestError";
  constructor(readonly errorType: string) {
    super(errorType);
  }
}

/** Sandbox/preprod guard, same spirit as the platform requester's: nothing non-synthetic leaves the device. */
export function assertSyntheticBundle(bundle: CredentialBundle): void {
  const s = summarise(bundle);
  if (!s.consentId?.startsWith("SYNTHETIC") || !s.customerId?.startsWith("customer-test-")) {
    throw new Error("refusing to send: credentials are not marked synthetic (consentId SYNTHETIC-*, customerId customer-test-*)");
  }
}

export interface SessionDeps {
  keys: DeviceKeys;
  transport: Transport;
  /** Mock mode mints fresh synthetic credentials; real mode returns the imported bundle. */
  credentials: (holder: { did: string; jwk: Awaited<ReturnType<typeof publicJwk>> }) => Promise<CredentialBundle>;
  audience: string;
  newJobId?: () => string;
  now?: () => number;
}

/** Lifecycle hooks: persist before the network, persist the sealed reply before it is acknowledged, cancel. */
export interface RunOpts {
  signal?: AbortSignal;
  /** Called with the jobId after the job is built and signed, BEFORE anything is sent. */
  onSent?: (jobId: string) => Promise<void>;
  /** Called with the sealed reply `output` before the transport acks it. */
  onReply?: (jobId: string, output: string) => Promise<void>;
  /** Retry of a logical request reuses its jobId (relay dedupes; queue dedupes by jobId). */
  jobId?: string;
}

/** What the device tells the enclave so it only does NEW work. Both fields are covered by the presentation digest. */
export interface DeltaRequest {
  /** YYYY-MM-DD watermark: latest transaction date the device holds. Absent on first sync. */
  since?: string;
  /** Decision cache: key hash -> [category, essential 0|1]. Keys the enclave need not send to the model. */
  known: Record<string, [string, 0 | 1]>;
  /** Taxonomy the cached decisions were made under; the enclave ignores `known` if it runs another. */
  taxonomy?: string;
}

export interface DeltaResult {
  jobId: string;
  delta: DeltaDoc;
  meta: Record<string, unknown>;
  sealed: string;
  provenance: unknown;
}

type Kind = "full" | "delta";

async function buildJob(d: SessionDeps, prefs: Preferences | undefined, delta: DeltaRequest | undefined, jobIdIn?: string) {
  const holderJwk = await publicJwk(d.keys.holder.publicKey);
  const holderDid = didKeyFromP256Jwk(holderJwk);
  const replyTo = await publicJwk(d.keys.reply.publicKey);

  const bundle = await d.credentials({ did: holderDid, jwk: holderJwk });
  assertSyntheticBundle(bundle);

  const jobId = jobIdIn ?? d.newJobId?.() ?? crypto.randomUUID();
  const body: Record<string, unknown> = { schema: JOB_SCHEMA, prompt: "spend-analysis", replyTo };
  if (prefs && Object.keys(prefs).length) body["preferences"] = prefs;
  if (delta) body["delta"] = delta;

  const vp = await buildPresentation({
    holderDid,
    holderPrivateKey: d.keys.holder.privateKey,
    audience: d.audience,
    jobId,
    body,
    credentials: [bundle.agent, bundle.consent],
    now: d.now ? Math.floor(d.now() / 1000) : undefined,
  });
  const job: Job = { jobId, body: { ...body, vp } };
  return { job, replyTo };
}

/** Parse + unseal a reply `output` string. Throws PfmRequestError for anything malformed. */
export async function openReply(keys: DeviceKeys, output: string, kind: Kind): Promise<{ plaintext: unknown; meta: Record<string, unknown>; sealed: string; provenance: unknown }> {
  const replyTo = await publicJwk(keys.reply.publicKey);
  let out: { schema?: string; meta?: Record<string, unknown>; sealed?: string; provenance?: unknown };
  try {
    out = JSON.parse(output);
  } catch {
    throw new PfmRequestError("ReplyShapeError");
  }
  if (out.schema !== REPLY_SCHEMA || typeof out.sealed !== "string") throw new PfmRequestError("ReplyShapeError");

  let compact;
  try {
    compact = await compactDecrypt(out.sealed, keys.reply.privateKey);
  } catch {
    throw new PfmRequestError("ReplyUnsealError");
  }
  if (compact.protectedHeader.kid !== (await thumbprint(replyTo))) throw new PfmRequestError("ReplyKeyMismatchError");
  let plaintext: unknown;
  try {
    plaintext = JSON.parse(fromUtf8(compact.plaintext));
    if (kind === "full") checkInsights(plaintext);
  } catch (e) {
    if (e instanceof ReplyShapeError || e instanceof SyntaxError) throw new PfmRequestError("ReplyShapeError");
    throw e;
  }
  return { plaintext, meta: out.meta ?? {}, sealed: out.sealed, provenance: out.provenance ?? null };
}

async function finish(d: SessionDeps, reply: Reply, kind: Kind) {
  if (reply.outcome === "error") throw new PfmRequestError(reply.errorType);
  return openReply(d.keys, reply.output, kind);
}

/**
 * Wraps the caller's persistence hook so it runs exactly once per reply: transports that ack call it
 * first (before the ack); transports with nothing to ack (the in-process mock) get it from `settle`.
 */
function hooksFor(jobId: string, o: RunOpts) {
  let persisted = false;
  const hooks: SendHooks = {
    signal: o.signal,
    beforeAck: async (output) => {
      persisted = true;
      await o.onReply?.(jobId, output);
    },
  };
  const settle = async (reply: Reply) => {
    if (reply.outcome === "ok" && !persisted) await hooks.beforeAck!(reply.output);
    return reply;
  };
  return { hooks, settle };
}

export async function requestInsights(d: SessionDeps, prefs?: Preferences, onEvent?: OnEvent, o: RunOpts = {}): Promise<InsightsResult> {
  const say = onEvent ?? (() => undefined);
  const { job } = await buildJob(d, prefs, undefined, o.jobId);
  say("presentation signed over the request (covers the reply key)");
  await o.onSent?.(job.jobId);
  const h = hooksFor(job.jobId, o);
  const reply = await h.settle(await d.transport.send(job, say, h.hooks));
  const r = await finish(d, reply, "full");
  say("reply unsealed on this device");
  return { jobId: job.jobId, insights: r.plaintext as Insights, meta: r.meta, sealed: r.sealed, provenance: r.provenance };
}

/** Incremental request: the enclave classifies only keys not in `delta.known`, only records at/after `delta.since`. */
export async function requestDelta(d: SessionDeps, delta: DeltaRequest, onEvent?: OnEvent, o: RunOpts = {}): Promise<DeltaResult> {
  const say = onEvent ?? (() => undefined);
  const { job } = await buildJob(d, undefined, delta, o.jobId);
  say(`presentation signed (delta: ${Object.keys(delta.known).length} known keys${delta.since ? `, since ${delta.since}` : ", first sync"})`);
  await o.onSent?.(job.jobId);
  const h = hooksFor(job.jobId, o);
  const reply = await h.settle(await d.transport.send(job, say, h.hooks));
  return toDelta(job.jobId, await finish(d, reply, "delta"), say);
}

/** Re-attach to a job sent earlier (restart / backgrounded / dropped connection). Throws if the transport cannot resume. */
export async function resumeDelta(d: SessionDeps, jobId: string, onEvent?: OnEvent, o: RunOpts = {}): Promise<DeltaResult> {
  const say = onEvent ?? (() => undefined);
  if (!d.transport.resume) throw new PfmRequestError("ResumeUnsupported");
  const h = hooksFor(jobId, o);
  const reply = await h.settle(await d.transport.resume(jobId, say, h.hooks));
  return toDelta(jobId, await finish(d, reply, "delta"), say);
}

/** Apply a sealed reply already on disk (persisted before ack) — no network. */
export async function openStoredDelta(keys: DeviceKeys, jobId: string, output: string): Promise<DeltaResult> {
  return toDelta(jobId, await openReply(keys, output, "delta"), () => undefined);
}

function toDelta(jobId: string, r: Awaited<ReturnType<typeof openReply>>, say: OnEvent): DeltaResult {
  let delta: DeltaDoc;
  try {
    delta = parseDelta(r.plaintext);
  } catch {
    const p = r.plaintext as { schema?: unknown } | null;
    if (typeof p?.schema === "string" && p.schema.startsWith("urn:sahamati:pfm-insights:")) {
      try {
        checkInsights(r.plaintext);
        throw new LegacyReply(r.plaintext as Insights);
      } catch (e) {
        if (e instanceof LegacyReply) throw e;
      }
    }
    throw new PfmRequestError("ReplyShapeError");
  }
  say(`reply unsealed on this device (${delta.txns.length} new transactions)`);
  return { jobId, delta, meta: r.meta, sealed: r.sealed, provenance: r.provenance };
}
