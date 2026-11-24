"""
Standalone connectivity smoke test — NOT the production trigger path.

Runs inside a GCP Confidential VM and exercises the full demo Account
Aggregator flow against our own aa-backend (Cloud Run) end to end: its own
OTP login, link, consent handle + approval, fetch, categorise with the
distilled PFM model (categorise.py + models/pfm-student.npz, copied
unmodified from the pfm_agent handoff), and publish the result back.

This is deliberately the "our own TEE" path, not Octic's Airlock: the agent
code here makes an ordinary outbound HTTPS call, which is exactly what the
Airlock-hosted pfm_agent cannot do (it only has a local Unix-socket gate).
Synthetic data only — same demo OTPs/identifiers as the rest of this repo;
the statement content itself is real anonymised BS_Data (account redacted
at source).

For the real per-consent trigger — what aa-backend actually calls the
moment a customer approves consent in the app — see server.py + run.py.
This script stays only to prove the whole chain works end to end by hand.
"""
import os
import sys
import time

import requests

from run import run_for_consent

BASE = os.environ.get("AA_BACKEND_URL", "https://aa-demo-backend-1013365696056.asia-south1.run.app")
MOBILE = os.environ.get("AA_DEMO_MOBILE", "8888888888")
DEMO_OTP = "1234"
BANK_OTP = "1111"


def step(label: str):
    print(f"\n=== {label} ===", flush=True)


def main() -> int:
    print(f"TEE agent starting. Target AA backend: {BASE}", flush=True)
    session = requests.Session()
    session.headers.update({"content-type": "application/json"})

    step("1. Request OTP")
    r = session.post(f"{BASE}/v1/auth/otp/request", json={"mobile": MOBILE})
    r.raise_for_status()
    request_id = r.json()["requestId"]
    print(f"requestId={request_id}")

    step("2. Verify OTP")
    r = session.post(f"{BASE}/v1/auth/otp/verify", json={"requestId": request_id, "otp": DEMO_OTP})
    r.raise_for_status()
    token = r.json()["token"]
    session.headers.update({"authorization": f"Bearer {token}"})
    print("session established")

    step("3. Discovery")
    r = session.get(f"{BASE}/v1/discovery")
    r.raise_for_status()
    fips = r.json()["fips"]
    fip_id = fips[0]["id"]
    print(f"FIPs: {[f['name'] for f in fips]} -> using {fip_id}")

    step("4. Start link")
    r = session.post(f"{BASE}/v1/link/start", json={"fipId": fip_id})
    r.raise_for_status()
    link_ref = r.json()["linkRefNumber"]
    print(f"linkRefNumber={link_ref}")

    step("5. Submit identifiers (no SIM-binding check here, by design)")
    r = session.post(f"{BASE}/v1/link/identifiers", json={"linkRefNumber": link_ref, "dob": "01/01/1990"})
    r.raise_for_status()

    step("6. Bank OTP -> accounts")
    r = session.post(f"{BASE}/v1/link/accounts", json={"linkRefNumber": link_ref, "otp": BANK_OTP})
    r.raise_for_status()
    accounts = r.json()["accounts"]
    account_ref = accounts[0]["accountRef"]
    print(f"accounts: {[a['maskedNumber'] for a in accounts]} -> linking {account_ref}")

    step("7. Confirm link")
    r = session.post(f"{BASE}/v1/link/confirm", json={"linkRefNumber": link_ref, "accountRefs": [account_ref]})
    r.raise_for_status()
    print(f"linked: {r.json()['linked']}")

    step("8. FIU creates consent handle")
    r = session.post(f"{BASE}/v1/consent/handle", json={
        "fiuId": "tee-agent-demo",
        "purpose": "Prove a TEE-hosted agent can reach our own AA end to end",
        "fiTypes": ["DEPOSIT"],
    })
    r.raise_for_status()
    handle = r.json()["consentHandle"]
    print(f"consentHandle={handle}")

    step("9. Approve consent (as the customer)")
    r = session.post(f"{BASE}/v1/consent/{handle}/approve", json={"accountRefs": [account_ref]})
    r.raise_for_status()
    consent = r.json()
    consent_id = consent["consentId"]
    print(f"consent status={consent['status']} consentId={consent_id}")

    step("10-11. Fetch FI data and categorise (same logic server.py triggers per-consent)")
    insights = run_for_consent(consent_id)
    print(f"categorised {len(insights['transactions'])} transactions")

    step("12. Publish insights back to aa-backend (this script's own proof of outbound push)")
    r = session.post(f"{BASE}/v1/fi/insights/{consent_id}", json=insights)
    r.raise_for_status()
    print(f"posted insights for consentId={consent_id}")

    step("RESULT")
    print("SUCCESS: TEE-hosted agent fetched, categorised and published insights end to end.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.HTTPError as e:
        print(f"\nFAILED: HTTP error — {e} — body: {e.response.text if e.response else ''}", flush=True)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f"\nFAILED: {e}", flush=True)
        sys.exit(1)
    finally:
        # Keep the container alive briefly so `docker logs`/Cloud Logging can
        # flush before the instance's container exits.
        time.sleep(2)
