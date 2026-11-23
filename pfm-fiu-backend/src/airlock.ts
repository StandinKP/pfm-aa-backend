/**
 * Airlock client for the FIU's system (Octic handoff, Airlock >= 1.0.0-beta.44,
 * "start run carries consentId + fiDataRange in the clear"). One run:
 * login → start → find row → sign request → poll → fetch reply → open (HPKE) → chain.
 *
 * Secrets (system key, credential, reply key) are passed in as values by the
 * caller — they come from the secret store / files outside the repo, are never
 * logged and never leave this module except as signatures and the opened reply.
 * Everything else (fetch, clock, sleep) is injected so tests run offline.
 */
import { createHash, createPublicKey, randomUUID, sign as edSign, type KeyObject } from "node:crypto";
import { open } from "./hpke";

export const SUITE_ID = "HPKE-base/X25519-HKDF-SHA256/HKDF-SHA256/ChaCha20Poly1305";
const RETRY = new Set(["ORG_VM_RECOVERING", "DISPATCH_NOT_ACCEPTED", "ORG_VM_IMAGE_UPDATING"]);

export interface AirlockConfig {
  api: string;
  org: string;
  workloadId: string;
  digest: string;
  rebitServerId: string;
  rebitHost: string;
  environment: string;
}
export interface AirlockSecrets { systemKey: KeyObject; credential: string; replyKey: KeyObject }
export interface Range { from: string; to: string }
export interface Deps {
  fetch?: typeof fetch;
  now?: () => number; // ms
  sleep?: (ms: number) => Promise<void>;
}

export class AirlockError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly details: unknown, readonly requestId: string | null) {
    super(`airlock ${status} ${code ?? ""}`);
  }
}
/** A run that ended without a reply; `refusals` are receipt types/reasons (no payload data). */
export class RunRefusedError extends Error {
  constructor(readonly runId: string, readonly refusals: Array<[string, string | null]>) {
    super(`run ${runId} has no reply: ${refusals.map((r) => r.join(" ")).join("; ") || "no refusal receipt"}`);
  }
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const json = (v: unknown) => b64(Buffer.from(JSON.stringify(v)));

export type Stage = "starting" | "queued" | "waiting_for_vm" | "request_signed" | "running" | "fetching_reply";

export function createAirlock(cfg: AirlockConfig, sec: AirlockSecrets, deps: Deps = {}) {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const api = cfg.api.replace(/\/+$/, "");
  const kid = "key_" + b64(createHash("sha256").update(Buffer.from(createPublicKey(sec.systemKey).export({ format: "jwk" }).x!, "base64url")).digest());
  let token: string | undefined;

  /** vp+jwt presentation of the system credential (login and request). */
  function present(claims: Record<string, unknown>): string {
    const input = `${json({ alg: "EdDSA", kid, typ: "vp+jwt" })}.${json({ ...claims, vc: sec.credential })}`;
    return `${input}.${b64(edSign(null, Buffer.from(input), sec.systemKey))}`;
  }

  async function failure(r: Response): Promise<AirlockError> {
    const e = await r.json().then((j: any) => j.error ?? {}, () => ({}));
    return new AirlockError(r.status, e.errorCode ?? null, e.details ?? null, e.requestId ?? null);
  }

  async function login(): Promise<void> {
    const t = Math.floor(now() / 1000);
    const assertion = present({ aud: `${api}/v1/auth/token`, jti: randomUUID(), iat: t, exp: t + 120 });
    const r = await f(`${api}/v1/auth/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (r.status !== 200) throw await failure(r);
    token = ((await r.json()) as { accessToken: string }).accessToken;
  }

  async function call(method: string, path: string, ok: number[] = [200], body?: unknown): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      if (!token) await login();
      const r = await f(api + path, {
        method, signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (r.status === 401 && attempt === 1) { token = undefined; continue; } // TOKEN_EXPIRED: log in again, repeat once
      if (!ok.includes(r.status)) throw await failure(r);
      return r;
    }
  }

  async function startRun(consentId: string, range: Range): Promise<string> {
    const body = { manifestDigest: cfg.digest, environment: cfg.environment, request: { source: "rebit", rebitServerId: cfg.rebitServerId, consentId, fiDataRange: range } };
    let d: any;
    for (let attempt = 0; ; attempt++) {
      try { d = await (await call("POST", `/v1/workloads/${cfg.workloadId}/runs`, [202], body)).json(); break; }
      catch (e) {
        if (!(e instanceof AirlockError) || !e.code || !RETRY.has(e.code) || attempt === 5) throw e;
        await sleep(Math.min(30_000 * 2 ** attempt, 300_000));
      }
    }
    while (d.status === "queued") { await sleep(5_000); d = await (await call("GET", `/v1/dispatches/${d.dispatch_id}`)).json(); }
    if (d.status !== "accepted") throw new Error(`dispatch ${d.status}: no run`);
    return d.run_id;
  }

  async function findRow(runId: string, waitMs = 300_000): Promise<{ id: string; runId: string; sessionExpiresAt: string }> {
    const until = now() + waitMs;
    do {
      let cursor: string | null = null;
      do {
        const qs = new URLSearchParams({ workloadId: cfg.workloadId, environment: cfg.environment, status: "open", limit: "100", ...(cursor ? { cursor } : {}) });
        const page: any = await (await call("GET", `/v1/runs?${qs}`)).json();
        const row = page.runs.find((x: any) => x.runId === runId);
        if (row) return row;
        cursor = page.nextCursor ?? null;
      } while (cursor);
      await sleep(3_000);
    } while (now() < until);
    throw new Error(`run ${runId} never opened`);
  }

  async function signRequest(row: { id: string; runId: string; sessionExpiresAt: string }, consentId: string, range: Range): Promise<void> {
    const t = Math.floor(now() / 1000);
    const end = Math.floor(Date.parse(row.sessionExpiresAt) / 1000);
    const jws = present({
      iss: cfg.org, aud: row.runId, manifest_digest: cfg.digest,
      input: { source: "rebit", rebit_server: cfg.rebitHost, consent_id: consentId, fi_data_range: range },
      iat: t, exp: Math.min(t + 600, end), jti: randomUUID(),
    });
    await call("PUT", `/v1/runs/${row.id}/request`, [201], { jws });
  }

  function openReply(sealed: Uint8Array, runId: string): unknown {
    const env = JSON.parse(Buffer.from(sealed).toString("utf8"));
    if (env.suite !== SUITE_ID) throw new Error("unexpected reply suite");
    const info = new TextEncoder().encode(`airlock.reply.v1|${runId}|${cfg.digest}`);
    return JSON.parse(open({ recipientKey: sec.replyKey, enc: unb64(env.enc), ct: unb64(env.ct), info }).toString("utf8"));
  }

  const refusals = (chain: any): Array<[string, string | null]> =>
    (chain.receipts ?? []).map((rc: any) => rc.signed.body).filter((b: any) => String(b.type).endsWith(".refused"))
      .map((b: any): [string, string | null] => [b.type, b.attributes?.["airlock.refusal.reason"] ?? null]);

  /** One whole run. `onStage` reports progress (ids and stage names only). */
  async function run(consentId: string, range: Range, onStage: (s: Stage, runId?: string) => void = () => undefined) {
    onStage("starting");
    const runId = await startRun(consentId, range);
    onStage("waiting_for_vm", runId);
    const row = await findRow(runId);
    await signRequest(row, consentId, range); // within 10 minutes of the run opening
    onStage("request_signed", runId);
    onStage("running", runId);
    for (;;) {
      const s: any = await (await call("GET", `/v1/runs/${row.id}`)).json();
      if (s.status !== "open") break;
      await sleep(5_000);
    }
    onStage("fetching_reply", runId);
    const chain = await (await call("GET", `/v1/runs/${row.id}/chain`)).json();
    let sealed: Uint8Array;
    try { sealed = new Uint8Array(await (await call("GET", `/v1/runs/${row.id}/output`)).arrayBuffer()); }
    catch (e) {
      if (e instanceof AirlockError && e.code === "OUTPUT_NOT_FOUND") throw new RunRefusedError(runId, refusals(chain));
      throw e;
    }
    return { runId, rowId: row.id, answer: openReply(sealed, runId), chain };
  }

  /** Revoke the org's current reply key, publish `publicJwk`, and check the list shows exactly it. Keep every revoked private key. */
  async function publishReplyKey(publicJwk: { kty: "OKP"; crv: "X25519"; x: string }): Promise<string> {
    const keys: any[] = ((await (await call("GET", "/v1/org-keys")).json()) as any).keys;
    for (const k of keys) if (k.purpose === "reply_encryption" && !k.revokedAt) await call("POST", `/v1/org-keys/${k.id}/revoke`, [200, 201, 204]);
    const row: any = await (await call("POST", "/v1/org-keys", [200, 201], { purpose: "reply_encryption", publicKey: JSON.stringify(publicJwk) })).json();
    const after: any[] = ((await (await call("GET", "/v1/org-keys")).json()) as any).keys.filter((k: any) => k.purpose === "reply_encryption" && !k.revokedAt);
    if (after.length !== 1 || after[0].publicJwk?.x !== publicJwk.x) throw new Error("reply key list does not show exactly the new key");
    return row.kid;
  }

  return { run, present, openReply, publishReplyKey, kid };
}
export type Airlock = ReturnType<typeof createAirlock>;
