# `@ltm/api`

Node 26 HTTP service for the AI Life Time Machine runtime. It exposes health probes, the B00-B127 capability catalog and dispatcher, and typed JSON command/query gateways. The single-node profile stores state in SQLite; the distributed profile uses PostgreSQL with forced tenant RLS.

## Authentication

Production should use `LTM_AUTH_MODE=oidc`. The verifier pins an HTTPS issuer, audience, JWKS URL, token type and asymmetric algorithm allowlist; it enforces expiry, issued-at/max-age, tenant, roles, purposes and step-up ACR/AMR claims. Roles, tenant, permissions, guardian verification, and step-up status come only from verified server-side claims; matching client headers are rejected.

Configured tokens remain available for controlled non-production and explicitly accepted single-node deployments:

```json
[
  {
    "tokenSha256": "sha256-of-the-random-bearer-token-as-64-lowercase-hex-characters",
    "actorId": "operator-1",
    "tenantId": "tenant-1",
    "roles": ["platform_admin"],
    "allowedPurposes": ["product_operation"],
    "stepUp": true
  }
]
```

`tokenSha256` is preferred so the raw bearer secret is not stored in process configuration. A `token` field of at least 16 characters is accepted only outside production; configuring both is rejected. Static tokens are not an enterprise identity solution. Production refuses them unless `LTM_ALLOW_STATIC_TOKEN_AUTH=true` explicitly accepts that limitation. OIDC requires `LTM_OIDC_ISSUER`, `LTM_OIDC_AUDIENCE` and `LTM_OIDC_JWKS_URL`; deployed federation and key rotation evidence remain separate from code/config verification.

For local UI development only, `LTM_AUTH_MODE=local-synthetic-only` enables `Bearer local-consumer`, bound server-side to actor `user-synthetic`, tenant `tenant-local`, and role `consumer`. The service refuses this mode when `APP_ENV=production`. `x-ltm-step-up: true` is accepted only when local synthetic mode also sets `LTM_SANDBOX_STEP_UP_HEADER=true`; it is rejected otherwise. Never expose this sandbox mode outside a developer workstation.

Every authenticated request also supplies an allowed `x-purpose`. Writes require `Idempotency-Key`. The API never accepts actor, tenant, role, permission, or guardian-verification headers.

## Routes

- `GET /health/live`, `GET /health/ready`
- `GET /metrics` (aggregate Prometheus metrics; production requires a bearer whose SHA-256 is `LTM_METRICS_TOKEN_SHA256`)
- `GET /v1/catalog`, `/v1/catalog/skills`, `/v1/capabilities`
- `GET /v1/capabilities/:batchId`
- `POST /v1/capabilities` with `{ "batchId": "B01", "input": {...} }`
- `POST /v1/capabilities/:batchId` with `{ "input": {...} }` (or the input object directly)
- `POST /v1/commands` with `{ "command": "record.create", "input": {...} }`
- `POST /v1/queries` with `{ "query": "record.get", "input": {...} }`

The command catalog includes `evidence.register` and `evidence.revoke`; evidence queries include `evidence.get` and `evidence.list`. Signed evidence is tenant-bound and includes issuer, provider, explicit environment, exact opaque scope, artifact SHA-256, issuance/expiry, nonce, replay policy, key ID, and Ed25519 signature. Configure public verification keys with `LTM_EVIDENCE_TRUST_KEYS_JSON`. The API process rejects private evidence-signing key variables.

Static files are served from `product/apps/web/public` by default, including SPA fallback. Only filenames containing an 8-64 character hexadecimal content hash receive immutable caching; HTML and unhashed assets use `no-cache`. Set `LTM_STATIC_DIR=disabled` to disable static serving or set an explicit directory.

## Production boundary

`APP_ENV=production` defaults to `LTM_DEPLOYMENT_PROFILE=distributed`. That profile requires `DATABASE_URL` with `sslmode=verify-full`, OIDC/JWKS authentication, trusted public evidence keys and protected metrics. Startup verifies the schema contract and rejects PostgreSQL superuser or `BYPASSRLS` roles. Every command, query and B00-B127 capability handler uses the same asynchronous runtime port. An intentionally limited single-node deployment must explicitly set `LTM_DEPLOYMENT_PROFILE=single-node` and `LTM_ALLOW_SINGLE_NODE_SQLITE=true`.

Run `node tools/release-gate.mjs --profile=production`. It exits blocked until a real B127 record, immutable manifest/SBOM, independent approvals and signed deployment reports are supplied. `node tools/backup-drill.mjs` remains the local SQLite restore check; production PostgreSQL backup/restore evidence must come from the deployed backup system and an independently observed restore drill.

The machine-readable contract is [openapi.yaml](./openapi.yaml). Identity and authorization fields are deliberately absent from request schemas because they are resolved from server-side bearer-token principals.

## Run

```sh
pnpm --filter @ltm/api test
LTM_AUTH_MODE=local-synthetic-only pnpm --filter @ltm/api start
```
