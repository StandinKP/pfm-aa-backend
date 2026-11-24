# pfm-aa-backend

Backend for the PFM (spend-analysis) demo — the FIU's system. Synthetic data only.

- `pfm-fiu-backend/` — the server (mock, queue and Airlock modes). See its README.
- `pfm-client/src/` — app code the backend imports (envelope, Pub/Sub, mock enclave); both folders must stay side by side.
- `demo-aa-app/` — the AA side: a Flutter app + mock AA backend + our own
  TEE-hosted agent, independent of the FIU side above. See its README.

```sh
cd pfm-client && bun install && cd ../pfm-fiu-backend && bun install && bun test
```

No secrets live here: Airlock mode reads the system key, credential, reply key and access key from files outside the repo.
