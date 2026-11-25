"""
Core "run" logic for the TEE agent: given a consentId that is already
ACTIVE (approved by the customer in the app), fetch the FI data and
categorise it with the distilled PFM model. Returns the result; does not
push it anywhere.

This deliberately does NOT post the result back to aa-backend. In the real
trigger path (server.py), aa-backend itself starts the run and then polls
GET /v1/runs/:id to pull the result — the same start/poll/pull shape as
pfm-fiu-backend's airlock.ts — so the TEE agent only ever answers requests,
it never calls back out on its own.

Split out of agent.py so server.py can trigger exactly this step per
consent, instead of re-running agent.py's whole OTP/link/consent
walkthrough — that walkthrough stays as a standalone connectivity smoke
test, not the production-shaped trigger path.
"""
import os

import requests

from categorise import categorise_and_summarise

BASE = os.environ.get("AA_BACKEND_URL", "https://aa-demo-backend-1013365696056.asia-south1.run.app")


def run_for_consent(consent_id: str) -> dict:
    session = requests.Session()

    r = session.get(f"{BASE}/v1/fi/data/{consent_id}")
    r.raise_for_status()
    statements = r.json()["statements"]

    return categorise_and_summarise(statements)
