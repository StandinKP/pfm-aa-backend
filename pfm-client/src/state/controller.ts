/**
 * The controller: the only place that touches the network, the keys and the disk.
 * The view dispatches intents here; this dispatches facts to the store.
 *
 *   boot      render the stored ledger (no job), apply any reply that arrived but was not applied,
 *             and re-attach to a job that was in flight when the app died
 *   refresh   one budgeted DELTA job → merge into the ledger → re-derive
 *   resume    re-attach to a sent job by jobId (never re-sends)
 *   cancel    stop polling now; the job may still finish on the far side and is not applied
 */
import { deriveInsights } from "../analysis/derive";
import type { DeviceKeys } from "../lib/keys";
import type { KV } from "../lib/storage";
import { LegacyReply, PfmRequestError, openStoredDelta, requestDelta, resumeDelta, type DeltaResult, type SessionDeps } from "../pfm/session";
import { CancelledError, ReplyTimeoutError } from "../transport/types";
import { isTransient } from "../lib/retry";
import { decide } from "./cadence";
import type { Action, AppState } from "./app";
import type { Config, Secrets } from "./config";
import { buildTransport, type BuildEnv, type TransportBundle } from "./transports";
import { isPending, loadJob, saveJob, type JobRecord } from "./jobs";
import { buildDeltaRequest, loadLedger, mergeDelta, saveLedger, type Ledger, emptyLedger } from "./ledger";
import type { Store } from "./store";

export interface ControllerDeps {
  kv: KV;
  keys: DeviceKeys;
  store: Store<AppState, Action>;
  now?: () => Date;
  /** Test seam for the mock enclave's AA window. */
  mockProcess?: BuildEnv["mockProcess"];
  newJobId?: () => string;
  mockLatencyMs?: number;
  /** Test seam: wrap the built transport (e.g. to drop a connection or capture replies). */
  wrapTransport?: (b: TransportBundle) => TransportBundle;
}

export function createController(d: ControllerDeps) {
  const secrets: Secrets = { token: "", bundleText: "", accessKey: "" };
  const now = () => d.now?.() ?? new Date();
  let ledger: Ledger = emptyLedger();
  let abort: AbortController | null = null;
  const say = (line: string) => d.store.dispatch({ t: "log", line: `${now().toLocaleTimeString()}  ${line}` });

  const publish = () => {
    const c = decide(ledger.cadence, now());
    d.store.dispatch({
      t: "cadence",
      cadence: { manualAllowed: c.manualAllowed, due: c.due, reason: c.reason, nextDueAt: c.nextDueAt?.toISOString() ?? null, fetchesLeft: c.fetchesLeft, lastFetchAt: ledger.cadence.lastFetchAt },
    });
    d.store.dispatch({ t: "insights", insights: ledger.txns.length ? deriveInsights(ledger.txns) : null, ledgerTxns: ledger.txns.length });
  };

  const config = (): Config => d.store.get().config;
  const session = async (signal: AbortSignal): Promise<SessionDeps> => {
    const built = await buildTransport(config(), secrets, { kv: d.kv, mockProcess: d.mockProcess, mockLatencyMs: d.mockLatencyMs, signal });
    const b = d.wrapTransport ? d.wrapTransport(built) : built;
    say(`transport: ${b.transport.name}`);
    return { keys: d.keys, transport: b.transport, credentials: b.credentials, audience: b.audience, newJobId: d.newJobId };
  };

  const setJob = async (j: JobRecord, patch: Partial<JobRecord>): Promise<JobRecord> => {
    const next = { ...j, ...patch, updatedAt: now().getTime() };
    await saveJob(d.kv, next);
    return next;
  };

  /** Merge a delta into the ledger and mark the job applied. Idempotent per jobId. */
  async function apply(job: JobRecord, res: DeltaResult, ms: number): Promise<void> {
    const merged = mergeDelta(ledger, res.delta, now());
    ledger = merged.ledger;
    await saveLedger(d.kv, d.keys, ledger);
    await setJob(job, { status: "applied", sealedReply: undefined, error: undefined });
    d.store.dispatch({ t: "pending", jobId: null });
    const m = res.meta as { modelCalls?: number; keysCached?: number };
    d.store.dispatch({ t: "lastRun", lastRun: { modelCalls: Number(m.modelCalls ?? Object.keys(res.delta.newDecisions).length), keysCached: Number(m.keysCached ?? 0), newTxns: merged.added, ms } });
    publish();
    say(`applied: ${merged.added} new transactions, ${Object.keys(res.delta.newDecisions).length} model decisions`);
  }

  /** Classify a failure: final (enclave refusal) vs interrupted (can be resumed). */
  async function fail(job: JobRecord | undefined, e: unknown): Promise<void> {
    if (e instanceof CancelledError) {
      if (job) await setJob(job, { status: "cancelled" });
      d.store.dispatch({ t: "pending", jobId: null });
      d.store.dispatch({ t: "phase", phase: "idle", status: "Cancelled." });
      say("cancelled");
      return;
    }
    if (job?.status === "replied") {
      // The reply is safely on disk but could not be applied (e.g. storage full). Keep it: boot() applies it next launch.
      const msg = `Reply received but could not be saved (${e instanceof Error ? e.message : String(e)}). It is kept and will be applied on next launch.`;
      d.store.dispatch({ t: "pending", jobId: job.jobId });
      d.store.dispatch({ t: "phase", phase: "error", status: msg });
      say(`error: ${msg}`);
      return;
    }
    const transient = e instanceof ReplyTimeoutError || isTransient(e);
    if (transient && job && job.status === "sent") {
      d.store.dispatch({ t: "pending", jobId: job.jobId });
      d.store.dispatch({ t: "phase", phase: "interrupted", status: "The request is still pending. Tap Resume to re-attach; nothing is sent twice." });
      say(`interrupted: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const msg = e instanceof PfmRequestError ? (e.errorType === "ResumeUnsupported" ? "This connection cannot re-attach to an earlier request." : `Refused by the enclave: ${e.errorType}`) : e instanceof Error ? e.message : String(e);
    if (job) await setJob(job, { status: e instanceof PfmRequestError && e.errorType === "ResumeUnsupported" ? "lost" : "failed", error: msg });
    d.store.dispatch({ t: "pending", jobId: null });
    d.store.dispatch({ t: "phase", phase: "error", status: msg });
    say(`error: ${msg}`);
  }

  async function run(job: JobRecord | undefined, go: (signal: AbortSignal) => Promise<{ job: JobRecord | undefined; res: DeltaResult }>): Promise<void> {
    abort = new AbortController();
    const started = Date.now();
    d.store.dispatch({ t: "phase", phase: "working", status: "Working…" });
    let current = job;
    try {
      const r = await go(abort.signal);
      current = r.job;
      await apply(r.job!, r.res, Date.now() - started);
      d.store.dispatch({ t: "phase", phase: "idle", status: "" });
    } catch (e) {
      if (e instanceof LegacyReply) {
        const j = (await loadJob(d.kv)) ?? current;
        if (j) await setJob(j, { status: "applied", sealedReply: undefined });
        d.store.dispatch({ t: "pending", jobId: null });
        d.store.dispatch({ t: "legacy", doc: e.insights as Record<string, unknown> });
        d.store.dispatch({ t: "phase", phase: "idle", status: "This enclave does not support incremental mode yet; showing its full result (nothing is stored on this device)." });
        say("legacy enclave: full document shown, ledger unchanged");
      } else {
        await fail((await loadJob(d.kv)) ?? current, e);
      }
    } finally {
      abort = null;
    }
  }

  /** The persistence hooks every send/resume shares. */
  const hooks = (jobRef: { j?: JobRecord }) => ({
    onReply: async (_id: string, output: string) => {
      jobRef.j = await setJob(jobRef.j!, { status: "replied", sealedReply: output }); // sealed reply on disk before the transport acks
    },
  });

  return {
    secrets,
    getLedger: () => ledger,

    setConfig(partial: Partial<Config>) {
      const config = { ...d.store.get().config, ...partial };
      d.store.dispatch({ t: "config", config });
      void d.kv.set("config", config); // persisted on change, not only on click
    },

    async boot(): Promise<void> {
      ledger = await loadLedger(d.kv, d.keys);
      publish();
      const job = await loadJob(d.kv);
      if (!isPending(job)) return;
      if (job.status === "replied" && job.sealedReply) {
        // A reply reached the device but the app died before applying it: no network needed.
        say("applying a reply that arrived before the app was closed");
        try {
          await apply(job, await openStoredDelta(d.keys, job.jobId, job.sealedReply), 0);
        } catch (e) {
          await fail(job, e);
        }
        return;
      }
      d.store.dispatch({ t: "pending", jobId: job.jobId });
      d.store.dispatch({ t: "phase", phase: "interrupted", status: "A request was in flight when the app closed." });
      if (config().mode === "relay") void this.resume(); // the relay needs no pasted secret: re-attach now
    },

    /** One budgeted delta refresh. `manual` is a user tap; there is no automatic caller. */
    async refresh(): Promise<void> {
      if (d.store.get().phase === "working") return;
      const c = decide(ledger.cadence, now());
      if (!c.manualAllowed) {
        d.store.dispatch({ t: "phase", phase: "idle", status: c.reason ?? "Refresh not available right now." });
        return;
      }
      const ref: { j?: JobRecord } = {};
      await run(undefined, async (signal) => {
        const s = await session(signal);
        const res = await requestDelta(s, buildDeltaRequest(ledger), say, {
          signal,
          onSent: async (jobId) => {
            ref.j = { jobId, mode: config().mode, status: "sent", createdAt: now().getTime(), updatedAt: now().getTime() };
            await saveJob(d.kv, ref.j); // persisted BEFORE the network call
            d.store.dispatch({ t: "pending", jobId });
          },
          ...hooks(ref),
        });
        return { job: ref.j, res };
      });
    },

    async resume(): Promise<void> {
      if (d.store.get().phase === "working") return;
      const job = await loadJob(d.kv);
      if (!isPending(job)) return;
      const ref: { j?: JobRecord } = { j: job };
      await run(job, async (signal) => {
        const s = await session(signal);
        const res = await resumeDelta(s, job.jobId, say, { signal, ...hooks(ref) });
        return { job: ref.j, res };
      });
    },

    cancel(): void {
      abort?.abort();
    },

    /** Delete keys, ledger, job and cached credentials. Awaits the IndexedDB delete (the old code did not). */
    async forget(): Promise<void> {
      abort?.abort();
      await new Promise<void>((resolve) => {
        const r = indexedDB.deleteDatabase("pfm-device");
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      });
      for (const k of ["bundle", "ledger", "job", "lastSealed", "config"]) await d.kv.delete(k);
      ledger = emptyLedger();
      d.store.dispatch({ t: "reset" });
    },
  };
}
