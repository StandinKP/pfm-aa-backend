/**
 * Build the verifiable presentation that rides inside the encrypted job body.
 *
 * Profile: urn:sahamati:vc-profile:1 (ADR-004; corpus in issuer/tests/fixtures/corpus).
 *
 *   header   { alg: ES256, typ: "vp+jwt", kid: <holder did:key>#<fragment> }
 *   payload  { iss: holder did:key, aud: workload audience, jti, iat, exp,
 *              jobId, payloadDigest, profile, vp: VCDM 2.0 presentation }
 *
 * `payloadDigest` is SHA-256 over the RFC 8785 canonical JSON of the request
 * body with the `vp` key REMOVED. Because `replyTo` is inside that body, the
 * holder's signature also covers the device reply key — a relaying FIU backend
 * cannot swap in its own key without breaking the digest. (Closes the
 * "key substitution" gap in pfm-tee-kit docs/PFM-DESIGN.md §8, once the
 * enclave-side verifier ships; nothing verifies it in the sandbox yet.)
 *
 * Lifetime is capped at 120 s (profile maximum is 300): a presentation is a
 * bearer artefact for as long as it lives.
 */
import { CompactSign } from "jose";
import { b64u, sha256 } from "../lib/bytes";
import { canonicalBytes } from "../lib/jcs";

export const VC_PROFILE = "urn:sahamati:vc-profile:1";
export const MAX_LIFETIME_SECONDS = 300;

export async function payloadDigest(body: Record<string, unknown>): Promise<string> {
  const { vp: _vp, ...rest } = body;
  return `sha-256=${b64u(await sha256(canonicalBytes(rest)))}`;
}

export interface PresentationInput {
  holderDid: string;
  holderPrivateKey: CryptoKey;
  /** `urn:sahamati:cs-workload:<env>:<partner>` */
  audience: string;
  jobId: string;
  /** The job body WITHOUT `vp`. */
  body: Record<string, unknown>;
  /** vc+jwt compact strings, in profile order: agent credential, then consent credential. */
  credentials: [agent: string, consent: string];
  /** Unix seconds; injectable for tests. */
  now?: number;
  lifetimeSeconds?: number;
}

export async function buildPresentation(i: PresentationInput): Promise<string> {
  const lifetime = i.lifetimeSeconds ?? 120;
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_SECONDS) throw new Error("presentation lifetime outside the profile limit");
  const iat = i.now ?? Math.floor(Date.now() / 1000);
  const payload = {
    iss: i.holderDid,
    aud: i.audience,
    jti: `urn:uuid:${crypto.randomUUID()}`,
    iat,
    exp: iat + lifetime,
    jobId: i.jobId,
    payloadDigest: await payloadDigest(i.body),
    profile: VC_PROFILE,
    vp: {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      holder: i.holderDid,
      verifiableCredential: i.credentials.map((vc) => ({
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["EnvelopedVerifiableCredential"],
        id: `data:application/vc+jwt,${vc}`,
      })),
    },
  };
  const fragment = i.holderDid.slice("did:key:".length);
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", typ: "vp+jwt", kid: `${i.holderDid}#${fragment}` })
    .sign(i.holderPrivateKey);
}
