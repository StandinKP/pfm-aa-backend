// Mock Account Aggregator backend — demo only.
//
// Replicates the shape of the real flow we observed in Saafe's sandbox app:
// mobile+OTP login -> FIP discovery -> identifier match -> bank OTP ->
// account selection -> link -> (separately) an FIU-initiated consent
// handle -> approval -> synthetic FI data.
//
// Deliberately skips SIM-binding (the real app's device-identity check,
// which an emulator/web client can never satisfy) and uses fixed demo
// OTPs, logged to the console instead of sent over SMS. Synthetic data
// only — no real PAN/DOB/account numbers are ever stored or required.

const DEMO_OTP = "1234";
const BANK_OTP = "1111";

interface Session { mobile: string }
interface LinkRequest { fipId: string; mobile: string; accounts?: Account[] }
interface Account { accountRef: string; fipId: string; maskedNumber: string; type: string }
interface Consent {
  consentHandle: string;
  fiuId: string;
  purpose: string;
  fiTypes: string[];
  dateRangeFrom: string;
  dateRangeTo: string;
  status: "PENDING" | "ACTIVE" | "REJECTED";
  accountRefs: string[];
  consentId?: string;
}

const FIPS = [
  { id: "demo-bank", name: "Demo Bank" },
  { id: "aa-sandbox-bank", name: "AA Sandbox Bank" },
];

const otpRequests = new Map<string, { mobile: string }>();
const sessions = new Map<string, Session>();
const linkRequests = new Map<string, LinkRequest>();
const linkedAccountsByMobile = new Map<string, Account[]>();
const consents = new Map<string, Consent>();
const insightsByConsentId = new Map<string, unknown>();

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(++counter).toString(36)}-${Date.now().toString(36)}`;

// A real anonymised BS_Data statement (account already redacted at source),
// used as the mock FI data for every linked account — far more realistic
// than a 3-row placeholder, and exercises the categoriser the same way the
// real 416-statement test set does.
const sampleTransactions = (await Bun.file(`${import.meta.dir}/../data/sample-statement.json`).json())
  .transactions as Array<{ date: string; amount: number; balance: number; category: string; chqNo: string; narration: string }>;

function synthStatement(acc: Account) {
  const bank = FIPS.find((f) => f.id === acc.fipId)?.name ?? acc.fipId;
  return {
    bank,
    account: acc.maskedNumber,
    transactions: sampleTransactions,
  };
}

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, { ...init, headers: { "access-control-allow-origin": "*", ...init.headers } });
}

function bearer(req: Request): Session | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return sessions.get(token) ?? null;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8788),
  routes: {
    "/v1/auth/otp/request": {
      POST: async (req) => {
        const { mobile } = await req.json();
        if (!mobile) return json({ error: "mobile required" }, { status: 400 });
        const requestId = nextId("otpreq");
        otpRequests.set(requestId, { mobile });
        console.log(`[demo-aa] OTP for ${mobile}: ${DEMO_OTP} (requestId ${requestId})`);
        return json({ requestId });
      },
    },
    "/v1/auth/otp/verify": {
      POST: async (req) => {
        const { requestId, otp } = await req.json();
        const pending = otpRequests.get(requestId);
        if (!pending) return json({ error: "unknown requestId" }, { status: 404 });
        if (otp !== DEMO_OTP) return json({ error: "Incorrect otp" }, { status: 400 });
        otpRequests.delete(requestId);
        const token = nextId("sess");
        sessions.set(token, { mobile: pending.mobile });
        return json({ token });
      },
    },
    "/v1/discovery": {
      GET: () => json({ fips: FIPS }),
    },
    "/v1/link/start": {
      POST: async (req) => {
        const session = bearer(req);
        if (!session) return json({ error: "unauthorized" }, { status: 401 });
        const { fipId } = await req.json();
        if (!FIPS.some((f) => f.id === fipId)) return json({ error: "unknown fipId" }, { status: 400 });
        const linkRefNumber = nextId("link");
        linkRequests.set(linkRefNumber, { fipId, mobile: session.mobile });
        return json({ linkRefNumber });
      },
    },
    "/v1/link/identifiers": {
      POST: async (req) => {
        const { linkRefNumber } = await req.json();
        if (!linkRequests.has(linkRefNumber)) return json({ error: "unknown linkRefNumber" }, { status: 404 });
        // Real AA: validates PAN/DOB against the FIP's KYC record, then
        // requires SIM-bound device verification before the bank will
        // even issue an OTP. This demo skips both — any identifier value
        // is accepted, since the point is the flow shape, not real KYC.
        console.log(`[demo-aa] bank OTP for linkRef ${linkRefNumber}: ${BANK_OTP}`);
        return json({ ok: true });
      },
    },
    "/v1/link/accounts": {
      POST: async (req) => {
        const { linkRefNumber, otp } = await req.json();
        const link = linkRequests.get(linkRefNumber);
        if (!link) return json({ error: "unknown linkRefNumber" }, { status: 404 });
        if (otp !== BANK_OTP) return json({ error: "Incorrect otp" }, { status: 400 });
        const accounts: Account[] = [
          { accountRef: nextId("acc"), fipId: link.fipId, maskedNumber: "XXXXXX1234", type: "Savings" },
          { accountRef: nextId("acc"), fipId: link.fipId, maskedNumber: "XXXXXX5678", type: "Current" },
        ];
        link.accounts = accounts;
        return json({ accounts });
      },
    },
    "/v1/link/confirm": {
      POST: async (req) => {
        const { linkRefNumber, accountRefs } = await req.json();
        const link = linkRequests.get(linkRefNumber);
        if (!link?.accounts) return json({ error: "unknown or unverified linkRefNumber" }, { status: 404 });
        const chosen = link.accounts.filter((a) => accountRefs.includes(a.accountRef));
        const existing = linkedAccountsByMobile.get(link.mobile) ?? [];
        linkedAccountsByMobile.set(link.mobile, [...existing, ...chosen]);
        linkRequests.delete(linkRefNumber);
        return json({ linked: chosen });
      },
    },
    "/v1/accounts": {
      GET: (req) => {
        const session = bearer(req);
        if (!session) return json({ error: "unauthorized" }, { status: 401 });
        return json({ accounts: linkedAccountsByMobile.get(session.mobile) ?? [] });
      },
    },
    // Called by an FIU backend (e.g. pfm-fiu-backend) to start a real
    // consent request against this AA — the ReBIT-shaped entry point.
    "/v1/consent/handle": {
      POST: async (req) => {
        const body = await req.json();
        const { fiuId, purpose, fiTypes, dateRangeFrom, dateRangeTo } = body;
        if (!fiuId || !purpose) return json({ error: "fiuId and purpose required" }, { status: 400 });
        const consentHandle = nextId("handle");
        consents.set(consentHandle, {
          consentHandle, fiuId, purpose,
          fiTypes: fiTypes ?? ["DEPOSIT"],
          dateRangeFrom: dateRangeFrom ?? "2026-01-01",
          dateRangeTo: dateRangeTo ?? "2026-12-31",
          status: "PENDING",
          accountRefs: [],
        });
        console.log(`[demo-aa] consent handle created: ${consentHandle} for FIU ${fiuId}`);
        return json({ consentHandle });
      },
    },
    "/v1/consent/:handle": {
      GET: (req) => {
        const consent = consents.get(req.params.handle);
        if (!consent) return json({ error: "unknown consent handle" }, { status: 404 });
        return json(consent);
      },
    },
    "/v1/consent/:handle/approve": {
      POST: async (req) => {
        const session = bearer(req);
        if (!session) return json({ error: "unauthorized" }, { status: 401 });
        const consent = consents.get(req.params.handle);
        if (!consent) return json({ error: "unknown consent handle" }, { status: 404 });
        const { accountRefs } = await req.json();
        const mine = (linkedAccountsByMobile.get(session.mobile) ?? []).map((a) => a.accountRef);
        const chosen = (accountRefs as string[]).filter((r) => mine.includes(r));
        if (chosen.length === 0) return json({ error: "no valid accounts selected" }, { status: 400 });
        consent.status = "ACTIVE";
        consent.accountRefs = chosen;
        consent.consentId = nextId("consent");
        return json({ status: consent.status, consentId: consent.consentId });
      },
    },
    "/v1/consent/:handle/deny": {
      POST: (req) => {
        const consent = consents.get(req.params.handle);
        if (!consent) return json({ error: "unknown consent handle" }, { status: 404 });
        consent.status = "REJECTED";
        return json({ status: consent.status });
      },
    },
    // Called by the FIU once consent is ACTIVE — stand-in for /FI/request + /FI/fetch.
    "/v1/fi/data/:consentId": {
      GET: (req) => {
        const consent = [...consents.values()].find((c) => c.consentId === req.params.consentId);
        if (!consent || consent.status !== "ACTIVE") return json({ error: "no active consent" }, { status: 404 });
        const byRef = new Map(
          [...linkedAccountsByMobile.values()].flat().map((a) => [a.accountRef, a] as const)
        );
        const statements = consent.accountRefs.map((ref) => synthStatement(byRef.get(ref)!)).filter(Boolean);
        return json({ statements });
      },
    },
    // Our TEE-hosted agent posts its categorisation result here after
    // fetching + categorising FI data; the app polls the GET to display it.
    // No auth on the POST: this is a demo and the consentId is already the
    // unguessable capability. A real deployment would authenticate the FIU.
    "/v1/fi/insights/:consentId": {
      POST: async (req) => {
        const consent = [...consents.values()].find((c) => c.consentId === req.params.consentId);
        if (!consent || consent.status !== "ACTIVE") return json({ error: "no active consent" }, { status: 404 });
        const body = await req.json();
        insightsByConsentId.set(req.params.consentId, body);
        return json({ ok: true });
      },
      GET: (req) => {
        const insights = insightsByConsentId.get(req.params.consentId);
        if (!insights) return json({ error: "no insights yet" }, { status: 404 });
        return json(insights);
      },
    },
  },
  development: true,
});

console.log(`demo AA backend: ${server.url}`);
