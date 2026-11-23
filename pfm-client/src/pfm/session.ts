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
import type { Job, OnEvent, Transport } from "../transport/types";

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

export async function requestInsights(d: SessionDeps, prefs?: Preferences, onEvent?: OnEvent): Promise<InsightsResult> {
  const say = onEvent ?? (() => undefined);
  const holderJwk = await publicJwk(d.keys.holder.publicKey);
  const holderDid = didKeyFromP256Jwk(holderJwk);
  const replyTo = await publicJwk(d.keys.reply.publicKey);

  const bundle = await d.credentials({ did: holderDid, jwk: holderJwk });
  assertSyntheticBundle(bundle);

  const jobId = d.newJobId?.() ?? crypto.randomUUID();
  const body: Record<string, unknown> = { schema: JOB_SCHEMA, prompt: "spend-analysis", replyTo };
  if (prefs && Object.keys(prefs).length) body["preferences"] = prefs;

  const vp = await buildPresentation({
    holderDid,
    holderPrivateKey: d.keys.holder.privateKey,
    audience: d.audience,
    jobId,
    body,
    credentials: [bundle.agent, bundle.consent],
    now: d.now ? Math.floor(d.now() / 1000) : undefined,
  });
  say("presentation signed over the request (covers the reply key)");

  const job: Job = { jobId, body: { ...body, vp } };
  const reply = await d.transport.send(job, say);
  if (reply.outcome === "error") throw new PfmRequestError(reply.errorType);

  let out: { schema?: string; meta?: Record<string, unknown>; sealed?: string; provenance?: unknown };
  try {
    out = JSON.parse(reply.output);
  } catch {
    throw new PfmRequestError("ReplyShapeError");
  }
  if (out.schema !== REPLY_SCHEMA || typeof out.sealed !== "string") throw new PfmRequestError("ReplyShapeError");

  const { plaintext, protectedHeader } = await compactDecrypt(out.sealed, d.keys.reply.privateKey);
  if (protectedHeader.kid !== (await thumbprint(replyTo))) throw new PfmRequestError("ReplyKeyMismatchError");
  say("reply unsealed on this device");

  return { jobId, insights: JSON.parse(fromUtf8(plaintext)) as Insights, meta: out.meta ?? {}, sealed: out.sealed, provenance: out.provenance ?? null };
}
