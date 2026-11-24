# demo-aa-app

A self-contained, independent Account Aggregator app + backend + TEE agent,
built to replicate Saafe's sandbox AA flow end to end — minus the SIM-binding
device-identity check, which blocks testing from an emulator/CI and which
this demo doesn't need to reproduce. Separate from `pfm-client`/
`pfm-fiu-backend` above (the FIU side): this is the **AA side**, plus our
own TEE-hosted agent, independent of Octic's Airlock.

- `aa-mobile/` — Flutter app: mobile+OTP login, local passcode, account
  linking (FIP discovery → identifiers → bank OTP → account select), and a
  consent-approval screen for the FIU-initiated half of the protocol. Uses
  Saafe's own branding (icon + "Demo AA" label) for this collaboration.
- `aa-backend/` — mock AA server (Bun): the same flow shape, deployed on
  Cloud Run. Its one sample statement is a real anonymised BS_Data
  statement with all real names/company/address scrubbed to synthetic
  placeholders (`Demo Bank`, `JANE DOE`, `JOHN SMITH`, `EXAMPLE
  TECHNOLOGIES INDIA PVT LTD`) — structure and category distribution are
  real, identities are not.
- `tee-agent/` — runs the full AA flow (login → link → consent → fetch)
  against `aa-backend`, then categorises the result with Kaushal's actual
  distilled PFM model (`categorise.py` + `models/pfm-student.npz`, copied
  unmodified from his pfm_agent handoff) and posts insights back for the
  app to display. Runs inside a real Confidential VM (Intel TDX) on GCP —
  attestation verified (Secure Boot + measured boot + TDX quote), not
  simulated.

## Run it

```sh
cd demo-aa-app/aa-backend && bun install && bun src/main.ts   # :8788
cd demo-aa-app/aa-mobile && flutter run                        # point at :8788 via 10.0.2.2 on an emulator
```

`tee-agent/` needs a GCP project with Compute + Artifact Registry +
Confidential Computing APIs enabled, and a Confidential VM created with
Secure Boot on — see inline comments in `tee-agent/agent.py` and
`tee-agent/Dockerfile` for the exact shape.
