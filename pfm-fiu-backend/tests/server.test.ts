import { describe, expect, test } from "bun:test";
import { createHandler, MAX_BODY_BYTES } from "../src/server";
import { createMockIssuer } from "../../pfm-client/src/mock/issuer";
import { createMockTransport } from "../../pfm-client/src/mock/transport";
import { loadOrCreateDeviceKeys, memoryKeyStore, publicJwk } from "../../pfm-client/src/lib/keys";
import { createRelayTransport, relayConfig, relayCredentials, relayLatest, relayLogin } from "../../pfm-client/src/transport/relay";
import { requestInsights, type SessionDeps } from "../../pfm-client/src/pfm/session";
import { resolveNames } from "../../pfm-client/src/transport/names";
import { didKeyFromP256Jwk } from "../../pfm-client/src/lib/didkey";

const URL_ = "http://backend.test";

async function boot(opts: { transportDelayMs?: number } = {}) {
  const names = resolveNames("sandbox", "pfm");
  const issuer = await createMockIssuer();
  const inner = createMockTransport({ trust: { issuerJwk: issuer.publicJwk, workloadAudience: names.audience, seen: new Set() }, latencyMs: opts.transportDelayMs ?? 0 });
  const logs: string[] = [];
  const handler = createHandler({ transport: inner, audience: names.audience, issuer, log: (e, f) => logs.push(JSON.stringify({ e, ...f })) });
  const fetchImpl = ((u: string, init?: RequestInit) => handler(new Request(u, init))) as unknown as typeof fetch;
  const keys = await loadOrCreateDeviceKeys(memoryKeyStore());
  const token = await relayLogin(URL_, "customer-test-001", fetchImpl);
  const deps: SessionDeps = {
    keys, audience: (await relayConfig(URL_, fetchImpl)).audience,
    transport: createRelayTransport({ baseUrl: URL_, token, fetchImpl }),
    credentials: (h) => relayCredentials(URL_, token, h, fetchImpl),
  };
  return { deps, handler, fetchImpl, token, logs, keys, run: () => requestInsights(deps) };
}

describe("mock FIU backend", () => {
  test("app → backend → enclave → backend → app: insights decrypted only on the device", async () => {
    const b = await boot();
    const res = await b.run();
    expect(res.insights.recordsIn).toBe(91);
    expect(res.insights.totals.spend).toBeGreaterThan(0);
  });

  test("the relay never sees plaintext: logs hold ids, sizes and types only", async () => {
    const b = await boot();
    const res = await b.run();
    const all = b.logs.join("\n");
    expect(all).toContain("job_relayed");
    for (const secret of [res.insights.accounts[0]!, "narration", "SYNTHETIC", "did:key", "eyJ"]) expect(all).not.toContain(secret);
  });

  test("stores the latest sealed reply (ciphertext) and serves it without a new fetch", async () => {
    const b = await boot();
    const res = await b.run();
    const got = await relayLatest(URL_, b.token, b.fetchImpl);
    expect(got.jobId).toBe(res.jobId);
    expect(got.output).toContain(res.sealed);
    expect(got.output).not.toContain("outflowsByCategory");
  });

  test("enclave refusals pass through as errorType only", async () => {
    const b = await boot();
    b.deps.audience = "urn:sahamati:cs-workload:sandbox:other";
    await expect(b.run()).rejects.toMatchObject({ errorType: "PresentationAudienceError" });
  });

  test("auth: no token → 401; non-synthetic customer → 403", async () => {
    const b = await boot();
    expect((await b.handler(new Request(`${URL_}/v1/insights/latest`))).status).toBe(401);
    const r = await b.handler(new Request(`${URL_}/v1/session`, { method: "POST", body: JSON.stringify({ customerId: "cust-0042" }) }));
    expect(r.status).toBe(403);
  });

  test("replayed jobId → 409; oversized body → 413; malformed → 400", async () => {
    const b = await boot();
    const post = (body: string) => b.handler(new Request(`${URL_}/v1/insights`, { method: "POST", headers: { authorization: `Bearer ${b.token}` }, body }));
    expect((await post("x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await post("{}")).status).toBe(400);
    const ok = JSON.stringify({ jobId: "7f3a9c21-4b6e-4d18-9a2c-5e8f1b0d3a74", body: { vp: "a.b.c", replyTo: {} } });
    await post(ok);
    expect((await post(ok)).status).toBe(409);
  });

  test("one request in flight per customer → 429", async () => {
    const b = await boot({ transportDelayMs: 60 });
    const mk = (id: string) => b.handler(new Request(`${URL_}/v1/insights`, { method: "POST", headers: { authorization: `Bearer ${b.token}` }, body: JSON.stringify({ jobId: id, body: { vp: "a.b.c", replyTo: {} } }) }));
    const [a, c] = await Promise.all([mk("aaaaaaaaaaaaaaaa-1"), mk("bbbbbbbbbbbbbbbb-2")]);
    expect([a.status, c.status].sort()).toEqual([200, 429]);
  });

  test("credential issuance binds the did to the key", async () => {
    const b = await boot();
    const k = await publicJwk(b.keys.holder.publicKey);
    const bad = await b.handler(new Request(`${URL_}/v1/credentials`, { method: "POST", headers: { authorization: `Bearer ${b.token}` }, body: JSON.stringify({ holder: { did: "did:key:zWrong", jwk: k } }) }));
    expect(bad.status).toBe(400);
    const good = await relayCredentials(URL_, b.token, { did: didKeyFromP256Jwk(k), jwk: k }, b.fetchImpl);
    expect(good.agent.split(".").length).toBe(3);
  });

  test("CORS only for known origins", async () => {
    const b = await boot();
    const ok = await b.handler(new Request(`${URL_}/v1/config`, { headers: { origin: "http://localhost:1420" } }));
    const no = await b.handler(new Request(`${URL_}/v1/config`, { headers: { origin: "https://evil.example" } }));
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});
