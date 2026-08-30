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

Open `http://127.0.0.1:8080`. The local server binds only to loopback, accepts the fixed synthetic identity, and explicitly enables the legacy consent-policy fixture mode for development only. Use `pnpm dev` instead for watch mode. Plain `pnpm start` stays fail-closed and requires server-side token and signed consent-policy configuration.

The browser embeds no bearer credential and exposes no manual production token
injection bridge. Production uses a public OIDC client with Authorization Code
+ PKCE S256. The API publishes only its closed public browser configuration;
the page stores a five-minute single-use state/verifier transaction in
`sessionStorage`, exchanges the code through the provider's CORS-enabled token
endpoint, keeps the access token only in module memory, and then requires
`/v1/session` plus the server-filtered visible-capability projection to pass.
Refresh tokens, callback replay/tampering, configuration drift, redirects,
non-JSON or oversized token responses all fail closed. The default local
synthetic API profile does not require browser OIDC and leaves the protected UI
signed out; use API tests/smoke or an approved HTTPS development IdP for UI
login.

Run an API smoke test in another terminal:

```bash
pnpm smoke
```

The complete local composition starts PostgreSQL, Redis, object storage, the
minimal API/web application, and the durable outbox/workflow worker with
separate liveness/readiness endpoints. It uses only synthetic local identity
and a shared local SQLite application volume; it never substitutes sandbox
delivery for a real external-provider result:

```bash
pnpm local:up
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8090/health/live
curl --fail http://127.0.0.1:8090/health/ready
pnpm local:down
```

Build the API and worker images with:

```bash
docker build -f services/api/Dockerfile -t ltm-api .
docker build -f services/workers/Dockerfile -t ltm-workers .
docker build -f services/integration-gateway/Dockerfile -t ltm-integration-gateway .
docker build -f services/client-integration-broker/Dockerfile -t ltm-client-integration-broker .
docker build -f services/migrator/Dockerfile -t ltm-migrator .
```

Production identity uses OIDC/JWKS. The worker accepts only HTTPS integration endpoints and AWS Secrets Manager references, and production startup requires all five outbox routes plus all 18 external-command batch mappings. Those batch adapters cover 19 fixed signed callback contracts because B10 has separate publish and provider-revoke operations.

The default local profile deliberately uses SQLite so the developer loop does not depend on Docker. The distributed profile uses the executable PostgreSQL adapter and ordered migrations under `infra/postgres/migrations`; every tenant transaction sets the RLS context and production rejects superuser or `BYPASSRLS` roles.

## Code map

- `skills` — canonical project skill catalog: 22 skills covering B00–B127
- `packages/core` — authorization, tenant storage, consent, idempotency, audit, events and ledger
- `packages/capabilities` — 22 skill domains and all 128 batch handlers
- `packages/providers` — official Apple/Google/WeChat verification, signed partner protocols, managed secrets, immutable evidence storage and sandbox adapters
- `services/api` — HTTP entrypoint, actor resolution, client identity/upload brokers and capability dispatch
- `services/workers` — deployable leased outbox delivery with signed, idempotent provider routing and bounded retry
- `services/integration-gateway` — provider-native callbacks, replay protection, immutable artifacts and atomic signed business-event projection
- `services/client-integration-broker` — official WeChat-to-IdP session exchange and Redis/S3/KMS-backed resumable uploads
- `services/migrator` — checksum-bound, least-privilege PostgreSQL schema migration runner
- `apps/web` — accessible consumer and operations console
- `apps/mobile`, `apps/wechat-mini` — executable mobile application state machine and native WeChat mini-program
- `packages/sdk-ts`, `packages/sdk-python`, `packages/sdk-java` — integration clients
- `docs/ARCHITECTURE.md` — runtime and trust boundaries
- `docs/PROJECT_STRUCTURE.md` — repository ownership, directory boundaries and compatibility paths
- `docs/IMPLEMENTATION_STATUS.md` — exact code-level scope and deliberate framework/runtime boundaries
- `docs/EXTERNAL_GATES.md` — evidence that cannot be certified locally

## Validation

`pnpm check` runs strict type checks, package tests, Python SDK tests, Java SDK compilation and production builds. Capability tests compare the executable registry with the factory manifest so missing or duplicate B00-B127 implementations fail the build.

The B00 baseline is an executable read-only inventory and command recorder. A plain inspection never calls a project script and therefore records available commands as `skipped`, not passed. The verification form runs the named package scripts without a shell and writes bounded, secret-redacted artifacts beneath the ignored `.artifacts/repository-baseline/` directory:

```bash
pnpm baseline:inspect
pnpm baseline:verify
```

It emits `inventory.json`, `command-log.ndjson`, `dependency-plan.json`, `risk-register.json`, and both JSON and Markdown baseline reports. The dependency plan resolves every B00-B127 handler back to its actual domain source file.

B02 also exposes deterministic local seed and schema-7 data-dictionary
generation commands. The dictionary binds every tenant table and sensitive JSON
surface to classification, retention, encryption, and allowed-purpose policy;
the seed creates only synthetic B01/B02 control-plane records:

```bash
pnpm contracts:generate
pnpm seed:local
```

Factory state remains available through:

```bash
make factory-status
make factory-ready
```

Code-level implementation is not a B127 production certificate. Live AI quality, payment/IAP/WeChat, tax/fapiao, app-store review, printing/logistics, independent penetration testing, legal review, multi-region recovery and staged production rollout remain `NOT_CERTIFIED` or `NOT_RUN` until their named evidence exists.

## Production release certification

The production gate reads B126 and B127 directly from PostgreSQL through a dedicated role with only `CONNECT`, schema `USAGE`, and `SELECT` on `ltm.schema_metadata`, `ltm.records`, `ltm.external_evidence`, and `ltm.evidence_consumptions`. The certifier rejects superuser, `BYPASSRLS`, role membership, write/DDL privileges, anything except PostgreSQL 17 with runtime schema 7, a connection that is not TLS verified with `sslmode=verify-full`, or drift in any of the exact schema-7 tenant tables (including durable commerce, growth, partner, tracking and warehouse state). Every table must enable and force RLS and expose one `PERMISSIVE ALL PUBLIC tenant_isolation` policy with exact tenant or partner context expressions. It binds `app.tenant_id` inside a repeatable-read, read-only transaction and never treats a SQLite export as production proof.

Consent disclosure authority is server-side: production startup requires a signed closed Ed25519 policy catalog, active public trust keys, and server-configured jurisdiction/locale. Each consent persists the catalog digest and resolved disclosure digest, and point-of-use checks fail closed after catalog, trust, policy, participant, or delegated-authority expiry. B127 release subjects bind the exact consent catalog digest together with the media lifecycle and media safety policy digests. The manifest also retains the exact authenticated media-authority response bytes, while the required signed `runtime-policy-authority` deployment report independently probes API readiness and `/v1/consent-policy/authority` plus broker readiness and `/v1/media/lifecycle/authority` over HTTPS workload identity/mTLS; all three observed digests must match the release subject.

A final B127 certificate is reachable only for the `global` wave at exactly 100%. The signed manifest must also bind the `full-commercial` profile; unique B00-B127 report hashes covering all 640 requirements; versioned API, web, TypeScript/Python/Java SDK, iOS, Android, WeChat and production-configuration artifacts; the closed eleven-domain guardrail policy; five completed zero-breach rollout waves; every raw monitoring query/result and automatic-pause command/receipt byte; the rollback-forward drill; an accepted B126 commercial E2E record with its own five consumed trusted Ed25519 envelopes; declared release exceptions; an approved go-live window; and an accepted operations handoff. Every raw rollout-control reference also binds a separate digest-addressed, production-only Ed25519 attestation whose closed claims identify the exact artifact, release, deployment, wave, metric, observation window, value and state. Query/result and pause-command/receipt attestations require their respective independently enrolled authority roles and distinct producer keys. Raw evidence, attestation IDs, nonces, signatures and digests cannot be reused across waves. Primary B127 evidence additionally requires the reserved `b127-production-release-authority` role, a production-only exact scope, independent Ed25519 key material and a `release-control:` identity; ordinary integration-gateway, direct-evidence, supply-event and callback keys cannot authorize B127. Production change approval requires independently enrolled risk and operations Ed25519 signers with different issuers and public keys, both independent from the enrolled executor and primary change signer. Canary and regional records remain intermediate and return `BLOCKED_EXTERNAL`.

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
