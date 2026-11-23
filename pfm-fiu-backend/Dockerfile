# MOCK FIU backend. Build context is a staged dir (see scripts/deploy-cloud-run.sh)
# holding pfm-fiu-backend/ and pfm-client/src/ side by side, because the backend
# imports the app's envelope, Pub/Sub and mock-enclave code.
FROM oven/bun:1.3-slim
WORKDIR /app
# The only runtime dependency (used by the shared mock enclave / sealing code).
RUN mkdir pfm-client && printf '{"name":"pfm-shared","private":true,"dependencies":{"jose":"6.2.15"}}' > pfm-client/package.json \
 && cd pfm-client && bun install --production
# Airlock mode's HPKE open needs @noble/ciphers (Bun's node:crypto has no chacha20-poly1305).
COPY pfm-fiu-backend/package.json pfm-fiu-backend/bun.lock ./pfm-fiu-backend/
RUN cd pfm-fiu-backend && bun install --production --frozen-lockfile
COPY pfm-client/src ./pfm-client/src
COPY pfm-fiu-backend/src ./pfm-fiu-backend/src
USER bun
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "pfm-fiu-backend/src/main.ts"]
