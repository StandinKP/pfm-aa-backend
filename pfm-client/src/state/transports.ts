/**
 * Builds the transport + credential source for a config. Everything stable is cached:
 *   - relay /v1/config (the audience) for an hour, with the cached copy as fallback if the backend is briefly down
 *   - the credential bundle until a day before its `validUntil`, per holder key
 * so a refresh costs one login + one job instead of four calls and a new credential set.
 */
import { createMockIssuer } from "../mock/issuer";
import { createMockTransport } from "../mock/transport";
import type { ProcessOpts } from "../mock/enclave";
import { createKmsCall, createQueueCrypto } from "../transport/envelope";
import { createPubSubClient } from "../transport/pubsubClient";
import { createPubSubTransport } from "../transport/pubsub";
import { resolveNames } from "../transport/names";
import { createRelayTransport, relayConfig, relayCredentials, relayLogin } from "../transport/relay";
import type { Transport } from "../transport/types";
import type { SessionDeps } from "../pfm/session";
import { parseBundle, summarise, type CredentialBundle } from "../vc/credentials";
import type { KV } from "../lib/storage";
import type { Config, Secrets } from "./config";

export interface TransportBundle {
  transport: Transport;
  credentials: SessionDeps["credentials"];
  audience: string;
}

const CONFIG_TTL_MS = 3_600_000;
const CRED_MARGIN_MS = 86_400_000;

export interface BuildEnv {
  kv: KV;
  now?: () => number;
  /** Test/dev seam for the mock enclave's AA window. */
  mockProcess?: ProcessOpts;
  mockLatencyMs?: number;
  signal?: AbortSignal;
}

export async function buildTransport(cfg: Config, s: Secrets, e: BuildEnv): Promise<TransportBundle> {
  const now = e.now ?? Date.now;
  if (cfg.mode === "mock") {
    const names = resolveNames("sandbox", "pfm");
    const issuer = await createMockIssuer();
    const transport = createMockTransport({ trust: { issuerJwk: issuer.publicJwk, workloadAudience: names.audience, seen: new Set() }, process: e.mockProcess, latencyMs: e.mockLatencyMs });
    return { transport, credentials: (h) => issuer.issue(h), audience: names.audience };
  }
  if (cfg.mode === "relay" || cfg.mode === "airlock") {
    const url = cfg.relayUrl.trim();
    const audience = await cachedAudience(url, e, now);
    const tok = await relayLogin(url, "customer-test-001", fetch, s.accessKey || undefined, e.signal);
    return {
      transport: createRelayTransport({ baseUrl: url, token: tok }),
      audience,
      credentials: async (h) => {
        const slot = `creds:${url}`;
        const hit = await e.kv.get<{ holder: string; bundle: CredentialBundle }>(slot);
        if (hit && hit.holder === h.did) {
          const until = Date.parse(summarise(hit.bundle).validUntil ?? "");
          if (Number.isFinite(until) && until - CRED_MARGIN_MS > now()) return hit.bundle;
        }
        const bundle = await relayCredentials(url, tok, h, fetch, e.signal);
        await e.kv.set(slot, { holder: h.did, bundle });
        return bundle;
      },
    };
  }
  if (!s.token.trim()) throw new Error("paste an access token first");
  const names = resolveNames(cfg.env, cfg.partner.trim());
  const supplier = async () => s.token.trim();
  const transport = createPubSubTransport({ names, pubsub: createPubSubClient(supplier), crypto: createQueueCrypto({ requestKek: names.requestKek, replyKek: names.replyKek, kms: createKmsCall(supplier) }) });
  return {
    transport,
    audience: names.audience,
    credentials: async () => {
      const raw = s.bundleText.trim() ? JSON.parse(s.bundleText) : await e.kv.get("bundle");
      const b = parseBundle(raw);
      await e.kv.set("bundle", b); // synthetic-only in sandbox; the guard enforces it
      return b;
    },
  };
}

async function cachedAudience(url: string, e: BuildEnv, now: () => number): Promise<string> {
  const slot = `relayConfig:${url}`;
  const hit = await e.kv.get<{ audience: string; at: number }>(slot);
  if (hit && now() - hit.at < CONFIG_TTL_MS) return hit.audience;
  try {
    const c = await relayConfig(url, fetch, e.signal);
    await e.kv.set(slot, { audience: c.audience, at: now() });
    return c.audience;
  } catch (err) {
    if (hit) return hit.audience; // backend briefly down: the audience is stable
    throw err;
  }
}
