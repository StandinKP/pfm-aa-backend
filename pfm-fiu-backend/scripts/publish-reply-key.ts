/**
 * One-off: make the org's X25519 reply key and publish its public half to Airlock
 * (Octic handoff, "The reply key"). Revokes the current reply key first — KEEP every
 * revoked private key: a run that read the key list before rotation still seals to it.
 *
 *   PFM_AIRLOCK_SYSTEM_KEY_FILE=… PFM_AIRLOCK_CREDENTIAL_FILE=… \
 *   bun scripts/publish-reply-key.ts <new-reply-key-output-path>      # path must not exist
 *
 * The private key is written 0600 to the path you give (outside the repo!); only the
 * public half is sent. Needs the system key, which is an admin key — run it from your
 * own shell, not from CI.
 */
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createAirlock } from "../src/airlock";

const out = process.argv[2];
if (!out || existsSync(out)) throw new Error("give a NEW path for the reply key (it will not overwrite)");
if (out.includes("/pfm-") || out.startsWith(process.cwd())) console.warn("warning: is this path inside a repo? Keep it out of version control.");
const need = (k: string) => process.env[k] ?? (() => { throw new Error(`needs ${k}`); })();

const { privateKey, publicKey } = generateKeyPairSync("x25519");
const x = publicKey.export({ format: "jwk" }).x!;
const al = createAirlock(
  { api: process.env["PFM_AIRLOCK_API"] ?? "https://api-airlock.sahamati.org.in", org: process.env["PFM_AIRLOCK_ORG"] ?? "kaushal-agent-test", workloadId: "-", digest: "-", rebitServerId: "-", rebitHost: "-", environment: "-" },
  { systemKey: createPrivateKey(readFileSync(need("PFM_AIRLOCK_SYSTEM_KEY_FILE"), "utf8")), credential: readFileSync(need("PFM_AIRLOCK_CREDENTIAL_FILE"), "utf8").trim(), replyKey: privateKey },
);
// Write the private key BEFORE publishing, so a crash cannot leave a published key with no private half.
writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
console.log("reply key", await al.publishReplyKey({ kty: "OKP", crv: "X25519", x }), "→ private half at", out);
