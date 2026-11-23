/**
 * The two credentials the app presents, as the compact vc+jwt strings it was given:
 *
 *   agent    SahamatiAgentCredential — binds the holder key (`cnf`) to a registered entity.
 *   consent  AccountAggregatorConsentCredential — issued by the consent issuer (the AA), subject = holder did:key.
 *
 * The app holds them; it does not verify them (the enclave does, against a trust
 * bundle baked into its image). `summarise` decodes claims for DISPLAY only and the
 * UI labels it "unverified". Where real ones come from is open: the platform's
 * credential issuance (ADR-004 Phase 1/3) is not built yet, so sandbox runs use the
 * mock issuer (src/mock/issuer.ts) and every mock credential is stamped SYNTHETIC.
 */
import { decodeJwt } from "jose";

export interface CredentialBundle {
  agent: string;
  consent: string;
}

export interface ConsentSummary {
  consentId?: string;
  customerId?: string;
  purposeText?: string;
  accountLabels?: string[];
  validUntil?: string;
  holder?: string;
  issuer?: string;
}

const COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function parseBundle(raw: unknown): CredentialBundle {
  const o = raw as Partial<CredentialBundle> | null;
  if (!o || typeof o.agent !== "string" || typeof o.consent !== "string" || !COMPACT.test(o.agent) || !COMPACT.test(o.consent)) {
    throw new Error('expected {"agent": "<vc+jwt>", "consent": "<vc+jwt>"}');
  }
  return { agent: o.agent.trim(), consent: o.consent.trim() };
}

export function summarise(bundle: CredentialBundle): ConsentSummary {
  const c = decodeJwt(bundle.consent) as { issuer?: string; validUntil?: string; credentialSubject?: Record<string, unknown> };
  const s = c.credentialSubject ?? {};
  return {
    consentId: s["consentId"] as string | undefined,
    customerId: s["customerId"] as string | undefined,
    purposeText: s["purposeText"] as string | undefined,
    accountLabels: s["accountLabels"] as string[] | undefined,
    validUntil: c.validUntil,
    holder: s["id"] as string | undefined,
    issuer: c.issuer,
  };
}
