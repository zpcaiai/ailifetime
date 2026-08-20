# `@ltm/api`

Node 26 HTTP service for the AI Life Time Machine runtime. It exposes health probes, the B00-B127 capability catalog and dispatcher, and typed JSON command/query gateways. Runtime state is stored durably in SQLite.

## Authentication

Production-like environments use `LTM_AUTH_MODE=configured-tokens` (the default) and must set `LTM_API_TOKENS_JSON` to a JSON array. Roles, tenant, permissions, guardian verification, and normal step-up status come only from these server-side records; matching client headers are rejected.

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

`tokenSha256` is preferred so the raw bearer secret is not stored in the process configuration. A `token` field of at least 16 characters is also supported when the deployment secret manager injects it directly; configuring both is rejected.

For local UI development only, `LTM_AUTH_MODE=local-synthetic-only` enables `Bearer local-consumer`, bound server-side to actor `user-synthetic`, tenant `tenant-local`, and role `consumer`. The service refuses this mode when `APP_ENV=production`. `x-ltm-step-up: true` is accepted only when local synthetic mode also sets `LTM_SANDBOX_STEP_UP_HEADER=true`; it is rejected otherwise. Never expose this sandbox mode outside a developer workstation.

Every authenticated request also supplies an allowed `x-purpose`. Writes require `Idempotency-Key`. The API never accepts actor, tenant, role, permission, or guardian-verification headers.

## Routes

- `GET /health/live`, `GET /health/ready`
- `GET /v1/catalog`, `/v1/catalog/skills`, `/v1/capabilities`
- `GET /v1/capabilities/:batchId`
- `POST /v1/capabilities` with `{ "batchId": "B01", "input": {...} }`
- `POST /v1/capabilities/:batchId` with `{ "input": {...} }` (or the input object directly)
- `POST /v1/commands` with `{ "command": "record.create", "input": {...} }`
- `POST /v1/queries` with `{ "query": "record.get", "input": {...} }`

Static files are served from `product/apps/web/public` by default, including SPA fallback. Set `LTM_STATIC_DIR=disabled` to disable it or set an explicit directory.

The machine-readable contract is [openapi.yaml](./openapi.yaml). Identity and authorization fields are deliberately absent from request schemas because they are resolved from server-side bearer-token principals.

## Run

```sh
pnpm --filter @ltm/api test
LTM_AUTH_MODE=local-synthetic-only pnpm --filter @ltm/api start
```
