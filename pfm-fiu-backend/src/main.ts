/**
 * Entry point. Mock mode (default) runs the mock enclave in-process: no GCP, no
 * credentials. Queue mode relays to a real slot with the REQUESTER identity taken
 * from GOOGLE_OAUTH_ACCESS_TOKEN (e.g. `gcloud auth print-access-token`) — never
 * from a file in this repo.
 *
 *   bun src/main.ts                          # mock, :8787
 *
 * Airlock mode (the FIU's system calling Airlock; see README) — secrets are FILES
 * (Secret Manager mounts on Cloud Run), never env values or repo content:
 *   PFM_BACKEND_MODE=airlock PFM_AIRLOCK_WORKLOAD_ID=… PFM_AIRLOCK_DIGEST=sha256:… \
 *   PFM_AIRLOCK_SYSTEM_KEY_FILE=… PFM_AIRLOCK_CREDENTIAL_FILE=… PFM_AIRLOCK_REPLY_KEY_FILE=… PFM_ACCESS_KEY_FILE=… bun src/main.ts
 *   PFM_BACKEND_MODE=queue PFM_ENV=sandbox PFM_PARTNER=pfm \
 *     GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) bun src/main.ts
 */
import { createMockIssuer } from "../../pfm-client/src/mock/issuer";
import { createMockTransport } from "../../pfm-client/src/mock/transport";
import { createKmsCall, createQueueCrypto } from "../../pfm-client/src/transport/envelope";
import { resolveNames, type Env } from "../../pfm-client/src/transport/names";
import { createPubSubTransport } from "../../pfm-client/src/transport/pubsub";
import { createPubSubClient } from "../../pfm-client/src/transport/pubsubClient";
import { createAirlock } from "./airlock";
import { createHandler } from "./server";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

const mode = process.env["PFM_BACKEND_MODE"] ?? "mock";
const env = (process.env["PFM_ENV"] ?? "sandbox") as Env;
const names = resolveNames(env, process.env["PFM_PARTNER"] ?? "pfm");
const port = Number(process.env["PORT"] ?? 8787);

let handler;
if (mode === "airlock") {
  const need = (k: string) => process.env[k] ?? (() => { throw new Error(`airlock mode needs ${k}`); })();
  const cfg = {
    api: process.env["PFM_AIRLOCK_API"] ?? "https://api-airlock.sahamati.org.in",
    org: process.env["PFM_AIRLOCK_ORG"] ?? "kaushal-agent-test",
    workloadId: need("PFM_AIRLOCK_WORKLOAD_ID"), digest: need("PFM_AIRLOCK_DIGEST"),
    rebitServerId: process.env["PFM_AIRLOCK_REBIT_SERVER_ID"] ?? "a8e29156-e661-435b-abf4-c776522f90a3", // sandbox
    rebitHost: process.env["PFM_AIRLOCK_REBIT_HOST"] ?? "sandbox-aa-airlock.sahamati.org.in",
    environment: process.env["PFM_AIRLOCK_ENV"] ?? "sandbox",
  };
  const file = (k: string) => readFileSync(need(k), "utf8");
  const airlock = createAirlock(cfg, {
    systemKey: createPrivateKey(file("PFM_AIRLOCK_SYSTEM_KEY_FILE")),
    credential: file("PFM_AIRLOCK_CREDENTIAL_FILE").trim(),
    replyKey: createPrivateKey(file("PFM_AIRLOCK_REPLY_KEY_FILE")),
  });
  const accessKey = file("PFM_ACCESS_KEY_FILE").trim(); // required: a session can start runs as the org's system
  if (accessKey.length < 16) throw new Error("PFM_ACCESS_KEY_FILE must hold at least 16 characters");
  handler = createHandler({
    audience: names.audience, log, accessKey,
    airlock: {
      run: airlock.run, environment: cfg.environment, agentDigest: cfg.digest, workloadId: cfg.workloadId,
      consentIds: (process.env["PFM_AIRLOCK_CONSENT_IDS"] ?? "sandbox-ok,sandbox-manual").split(","), rangeDays: 90,
    },
  });
} else if (mode === "queue") {
  const token = process.env["GOOGLE_OAUTH_ACCESS_TOKEN"];
  if (!token) throw new Error("queue mode needs GOOGLE_OAUTH_ACCESS_TOKEN (the slot's queue requester identity)");
  const supply = async () => token;
  const transport = createPubSubTransport({
    names, pubsub: createPubSubClient(supply),
    crypto: createQueueCrypto({ requestKek: names.requestKek, replyKek: names.replyKek, kms: createKmsCall(supply) }),
  });
  handler = createHandler({ transport, audience: names.audience, log });
} else {
  const issuer = await createMockIssuer();
  const transport = createMockTransport({ trust: { issuerJwk: issuer.publicJwk, workloadAudience: names.audience, seen: new Set() } });
  handler = createHandler({ transport, audience: names.audience, issuer, log });
}

function log(event: string, fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

Bun.serve({ port, hostname: "0.0.0.0", fetch: handler });
console.log(`mock FIU backend (${mode}) on :${port} — audience ${names.audience} — synthetic data only`);
