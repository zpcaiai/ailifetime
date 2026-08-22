# AI Life Time Machine

Executable full-commercial reference implementation for the AI Life Time Machine project factory.

- Product profile: `full-commercial` (B00–B127)
- Stack profile: `all-typescript`
- Runtime: Node.js 26, strict TypeScript, SQLite local adapter, executable PostgreSQL 17 production runtime with forced RLS
- Safety boundary: illustrative AI content only; per-participant purpose consent; private by default; revocable shares; verifiable deletion; no biometric high-impact decisioning

## Run locally

```bash
pnpm install
pnpm check
pnpm start:local
```

Open `http://127.0.0.1:8080`. The local server binds only to loopback and accepts the fixed synthetic identity. Use `pnpm dev` instead for watch mode. Plain `pnpm start` stays fail-closed and requires server-side token configuration.

Run an API smoke test in another terminal:

```bash
pnpm smoke
```

Optional infrastructure contract:

```bash
docker compose config --quiet
docker compose up -d postgres redis object-storage
```

Build the API and worker images with:

```bash
docker build -f services/api/Dockerfile -t ltm-api .
docker build -f services/workers/Dockerfile -t ltm-workers .
docker build -f services/integration-gateway/Dockerfile -t ltm-integration-gateway .
```

Production identity uses OIDC/JWKS. The worker accepts only HTTPS integration endpoints and AWS Secrets Manager references, and production startup requires all five outbox routes plus all 18 external-command batch mappings.

The default local profile deliberately uses SQLite so the developer loop does not depend on Docker. The distributed profile uses the executable PostgreSQL adapter and ordered migrations under `infra/postgres/migrations`; every tenant transaction sets the RLS context and production rejects superuser or `BYPASSRLS` roles.

## Code map

- `skills` — canonical project skill catalog: 22 skills covering B00–B127
- `packages/core` — authorization, tenant storage, consent, idempotency, audit, events and ledger
- `packages/capabilities` — 22 skill domains and all 128 batch handlers
- `packages/providers` — official Apple/Google/WeChat verification, signed partner protocols, managed secrets, immutable evidence storage and sandbox adapters
- `services/api` — HTTP entrypoint, actor resolution and capability dispatch
- `services/workers` — deployable leased outbox delivery with signed, idempotent provider routing and bounded retry
- `services/integration-gateway` — provider-native callbacks, replay protection, immutable artifacts and atomic signed business-event projection
- `apps/web` — accessible consumer and operations console
- `apps/mobile`, `apps/wechat-mini` — mobile/offline/deep-link and WeChat security primitives
- `packages/sdk-ts`, `packages/sdk-python`, `packages/sdk-java` — integration clients
- `docs/ARCHITECTURE.md` — runtime and trust boundaries
- `docs/PROJECT_STRUCTURE.md` — repository ownership, directory boundaries and compatibility paths
- `docs/IMPLEMENTATION_STATUS.md` — exact code-level scope and deliberate framework/runtime boundaries
- `docs/EXTERNAL_GATES.md` — evidence that cannot be certified locally

## Validation

`pnpm check` runs strict type checks, package tests, Python SDK tests, Java SDK compilation and production builds. Capability tests compare the executable registry with the factory manifest so missing or duplicate B00–B127 implementations fail the build.

Factory state remains available through:

```bash
make factory-status
make factory-ready
```

Code-level implementation is not a B127 production certificate. Live AI quality, payment/IAP/WeChat, tax/fapiao, app-store review, printing/logistics, independent penetration testing, legal review, multi-region recovery and staged production rollout remain `NOT_CERTIFIED` or `NOT_RUN` until their named evidence exists.

## Production release certification

The production gate reads B126 and B127 directly from PostgreSQL through a dedicated role with only `CONNECT`, schema `USAGE`, and `SELECT` on `ltm.schema_metadata`, `ltm.records`, `ltm.external_evidence`, and `ltm.evidence_consumptions`. The certifier rejects superuser, `BYPASSRLS`, role membership, write/DDL privileges, anything except PostgreSQL 17 with runtime schema 4, missing `FORCE ROW LEVEL SECURITY`, or a connection that is not TLS verified with `sslmode=verify-full`. It binds `app.tenant_id` inside a repeatable-read, read-only transaction and never treats a SQLite export as production proof.

A final B127 certificate is reachable only for the `global` wave at exactly 100%. The signed manifest must also bind the `full-commercial` profile; unique B00-B127 report hashes covering all 640 requirements; versioned API, web, TypeScript/Python/Java SDK, iOS, Android, WeChat and production-configuration artifacts; five completed zero-breach rollout waves; an accepted B126 commercial E2E record with its own five consumed trusted Ed25519 envelopes; declared release exceptions; an approved go-live window; and an accepted operations handoff. Canary and regional records remain intermediate and return `BLOCKED_EXTERNAL`.

Configure `LTM_B127_POSTGRES_URL`, `LTM_RELEASE_MANIFEST_PATH`, `LTM_TRUSTED_EVIDENCE_KEYS_FILE`, `LTM_RELEASE_TENANT_ID`, `LTM_RELEASE_LAUNCH_ID`, and the remaining production deployment evidence, then run:

```bash
node tools/release-gate.mjs --profile=production --b127-postgres-url="$LTM_B127_POSTGRES_URL"
```

Every required manifest approval must name its own immutable report bytes:

```json
{
  "artifact": {
    "path": "approvals/independent-pentest.json",
    "sha256": "64-lowercase-hex-characters"
  }
}
```

The path is relative to the product root, must be a regular non-writable file, and its SHA-256 is recomputed during certification. Reusing one report for two approvals is rejected unless the later approval explicitly names the earlier approval in `artifactReuse.withApproval` and supplies a substantive `artifactReuse.justification`.

For local-only fixture verification, SQLite remains available explicitly and cannot produce a production pass:

```bash
node tools/b127-certifier.mjs --profile=test --source=sqlite --database=.data/ltm-local.sqlite --manifest=release-manifest.json --trusted-keys=trusted-keys.json --tenant=tenant-local --launch-id=launch-local --expected-commit="$(git rev-parse HEAD)"
```
