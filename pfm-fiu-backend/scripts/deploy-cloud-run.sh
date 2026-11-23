#!/usr/bin/env bash
# Deploy the MOCK FIU backend to Cloud Run (source build via Cloud Build).
#
#   usage: ./scripts/deploy-cloud-run.sh            # project/region from env or defaults below
#   env:   GCP_PROJECT (default sahamati-labs)  REGION (default asia-south1)  SERVICE (default pfm-fiu-backend)
#
# Settings are deliberate:
#   --allow-unauthenticated   the app has no Google identity; the service is a synthetic-data mock
#                             (customer-test-* only, no secrets, no real enclave behind it)
#   --max-instances 1         sessions, dedupe and the latest-reply store are in memory
#   --min-instances 0         costs nothing idle; first request after idle pays a cold start
#   no secrets, no env       mock mode needs none
set -euo pipefail
PROJECT="${GCP_PROJECT:-sahamati-labs}"; REGION="${REGION:-asia-south1}"; SERVICE="${SERVICE:-pfm-fiu-backend}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pfm-fiu-backend" "$STAGE/pfm-client"
cp -R "$HERE/src" "$STAGE/pfm-fiu-backend/src"
cp -R "$ROOT/pfm-client/src" "$STAGE/pfm-client/src"
cp "$HERE/package.json" "$HERE/bun.lock" "$STAGE/pfm-fiu-backend/"
cp "$HERE/Dockerfile" "$STAGE/Dockerfile"
# Only source ships: no tests, node_modules, fixtures of other kinds, or env files.

gcloud run deploy "$SERVICE" --source "$STAGE" \
  --project "$PROJECT" --region "$REGION" \
  --allow-unauthenticated --max-instances 1 --min-instances 0 \
  --cpu 1 --memory 256Mi --timeout 150 --concurrency 20

gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)'
