/**
 * MOCK credential issuer — stands in for the platform's registry/issuer
 * (ADR-004 Phase 1/3, not built) and the AA's consent signing, for offline work
 * and tests. Everything it signs is synthetic and says so: the DID is on the
 * reserved `.invalid` TLD, consent ids start `SYNTHETIC-`, customer ids are
 * `customer-test-*`. Its key lives in memory only and is trusted by nothing
 * except the mock enclave in this directory.
 */
import { CompactSign, exportJWK } from "jose";
import { utf8 } from "../lib/bytes";
import type { P256PublicJwk } from "../lib/didkey";
import type { CredentialBundle } from "../vc/credentials";

export const MOCK_ISSUER_DID = "did:web:mock-issuer.invalid";

export interface MockIssuer {
  did: string;
  publicJwk: P256PublicJwk;
  issue(holder: { did: string; jwk: P256PublicJwk }, opts?: { now?: number; validDays?: number; accountLabels?: string[] }): Promise<CredentialBundle>;
}

export async function createMockIssuer(): Promise<MockIssuer> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await exportJWK(pair.publicKey);
  const publicJwk: P256PublicJwk = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };

  const sign = (claims: Record<string, unknown>): Promise<string> =>
    new CompactSign(utf8(JSON.stringify(claims)))
      .setProtectedHeader({ alg: "ES256", typ: "vc+jwt", kid: `${MOCK_ISSUER_DID}#key-1` })
      .sign(pair.privateKey);

  const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  return {
    did: MOCK_ISSUER_DID,
    publicJwk,
    async issue(holder, opts = {}) {
      const nbf = opts.now ?? Math.floor(Date.now() / 1000);
      const exp = nbf + (opts.validDays ?? 30) * 86_400;
      const base = {
        "@context": ["https://www.w3.org/ns/credentials/v2", "https://sahamati.org.in/ns/cs/v1"],
        issuer: MOCK_ISSUER_DID,
        validFrom: iso(nbf),
        validUntil: iso(exp),
        iss: MOCK_ISSUER_DID,
        nbf,
        exp,
      };
      const agent = await sign({
        ...base,
        id: `urn:uuid:${crypto.randomUUID()}`,
        type: ["VerifiableCredential", "SahamatiAgentCredential"],
        credentialSubject: { id: holder.did, type: "SahamatiAgent", entityId: "MOCK-ENTITY-PFM-FIU", roles: ["requester"], environment: "sandbox" },
        cnf: { jwk: holder.jwk },
        sub: holder.did,
      });
      const consent = await sign({
        ...base,
        id: `urn:uuid:${crypto.randomUUID()}`,
        type: ["VerifiableCredential", "AccountAggregatorConsentCredential"],
        credentialSubject: {
          id: holder.did,
          consentId: "SYNTHETIC-CONSENT-0001",
          consentHandle: "SYNTHETIC-HANDLE-0001",
          customerId: "customer-test-001",
          purposeCode: "101",
          purposeText: "Spend analysis",
          fiTypes: ["DEPOSIT"],
          accountLabels: opts.accountLabels ?? ["acc-1", "acc-2"],
          dataLife: { unit: "MONTH", value: 3 },
          frequency: { unit: "DAY", value: 1 },
          fetchType: "PERIODIC",
          consentStart: iso(nbf),
          consentExpiry: iso(exp),
        },
      });
      return { agent, consent };
    },
  };
}
