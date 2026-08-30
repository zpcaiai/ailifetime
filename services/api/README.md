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

When production serves the web application, it also requires
`LTM_PUBLIC_BASE_URL`, `LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT`,
`LTM_WEB_OIDC_TOKEN_ENDPOINT`, `LTM_WEB_OIDC_CLIENT_ID`,
`LTM_WEB_OIDC_REDIRECT_URI`, and `LTM_WEB_OIDC_SCOPES`. Authorization and token
endpoints must be exact HTTPS paths on the pinned issuer origin. The redirect
must equal `LTM_PUBLIC_BASE_URL + /auth/callback`; scopes must include `openid`
and must exclude `offline_access`. The registered public client has no client
secret, and its token endpoint must explicitly permit the production web origin
through CORS. Partial, cross-origin, cross-site redirect, query-bearing, or
refresh-capable configuration prevents production startup. Non-production
local profiles remain usable without these browser variables.

For local UI development only, `LTM_AUTH_MODE=local-synthetic-only` enables `Bearer local-consumer`, bound server-side to actor `user-synthetic`, tenant `tenant-local`, and role `consumer`. Local control-plane smoke tests use the separate `Bearer local-platform-admin` principal, limited to `platform_architecture` and `product_operation`; B01/B02 require their dedicated platform permissions and a platform-administrator or service role. The service refuses this mode when `APP_ENV=production`. `x-ltm-step-up: true` is accepted only when local synthetic mode also sets `LTM_SANDBOX_STEP_UP_HEADER=true`; it is rejected otherwise. Never expose this sandbox mode outside a developer workstation.

Every authenticated request also supplies an allowed `x-purpose`. Writes require `Idempotency-Key`. The API never accepts actor, tenant, role, permission, or guardian-verification headers.

## Routes

- `GET /health/live`, `GET /health/ready`
- `POST /v1/integrations/evidence-sink/preflight` (empty body; authenticated `service_account`; proves both `evidence:register` and `external-event:apply` on the same principal without mutating state)
- `GET /metrics` (aggregate Prometheus metrics; production requires a bearer whose SHA-256 is `LTM_METRICS_TOKEN_SHA256`)
- `GET /v1/auth/browser/config` for the closed, public, no-store SPA OIDC configuration
- `GET /v1/catalog`, `/v1/catalog/skills`, `/v1/capabilities`
- `GET /v1/session` for the server-verified actor/tenant/role projection
- `GET /v1/consent-policy/authority` for authenticated, server-verified signed-catalog metadata used by the production policy-authority probe
- `GET /v1/capabilities/visible` for the versioned role-and-permission-filtered portal manifest
- `POST /v1/auth/wechat/session`, `/v1/auth/session/refresh`, and `/v1/auth/session/logout` through the configured identity broker
- `POST /v1/uploads` and `/v1/uploads/:uploadId/{chunks,complete,cancel}` through the tenant-bound resumable media broker; chunk bodies are raw `application/octet-stream` bound to `Content-Range`, `X-Chunk-Sha256`, and `Idempotency-Key`
- `POST /v1/mobile/telemetry` for authenticated allowlisted operational fields; the server pseudonymizes the actor and persists through B41 without granting the consumer ingestion authority
- `GET /v1/capabilities/:batchId`
- `POST /v1/capabilities` with `{ "batchId": "B01", "input": {...} }`
- `POST /v1/capabilities/:batchId` with `{ "input": {...} }` (or the input object directly)
- `POST /v1/commands` with `{ "command": "record.create", "input": {...} }`
- `POST /v1/queries` with `{ "query": "record.get", "input": {...} }`

B05 is a closed deletion contract whose public input is exactly `{ "assetId": "...", "reason": "..." }`. Caller-supplied classification, retention, encryption or deletion targets are rejected. Before any side effect the API requires step-up authentication and a data-subject/guardian/household role or privacy/platform authority with an allowed deletion purpose. It then calls the broker with the server-resolved principal. The broker independently resolves ownership and the Ed25519-verified lifecycle policy and returns the policy digest plus the exact ordered target set and one strongly bound receipt per S3/HTTPS target. The API validates that closed response, requires every receipt to bind the same canonical digest, requires S3 version/delete-marker counts plus `verifiedAbsent=true`, and requires a provider receipt ID only for HTTPS targets. It supplies only those server-resolved lifecycle fields to the internal B05 handler. A missing broker, changed asset/tenant/policy binding, incomplete receipt set, legal hold, Object Lock, downstream failure or uncertain deletion fails closed. Retry resumes from the broker's durable per-target pending state; no client target name can enter the orchestration.

The command catalog includes `evidence.register` and `evidence.revoke`; evidence queries include `evidence.get` and `evidence.list`. Signed evidence is tenant-bound and includes issuer, provider, explicit environment, exact opaque scope, artifact SHA-256, issuance/expiry, nonce, replay policy, key ID, and Ed25519 signature. Configure public verification keys with `LTM_EVIDENCE_TRUST_KEYS_JSON`. Production forbids wildcard scopes. Final B127 keys must declare the reserved `b127-production-release-authority` role, use one exact `ltm-evidence:v1:<sha256>` scope and a production-only policy, and use an independent `release-control:` provider identity and key. The API rejects assigning that role to integration-gateway, direct-evidence, supply-event, or callback identities and rejects reuse of the B127 public key by another authority. The API process rejects private evidence-signing key variables.

Production consent requires `LTM_CONSENT_POLICY_CATALOG_FILE`, `LTM_CONSENT_POLICY_TRUST_KEYS_JSON`, `LTM_CONSENT_POLICY_JURISDICTION`, and `LTM_CONSENT_POLICY_LOCALE`. The catalog file is read as a bounded non-symlink regular JSON file and reverified with an active Ed25519 public key. Jurisdiction and locale are deployment configuration, never OIDC/static-token claims or request fields. `consent.grant` accepts an optional `evidenceHash`; when present it must exactly equal the server-resolved disclosure digest. Non-production legacy fixtures must opt in with `LTM_ALLOW_LEGACY_CONSENT_POLICY=true`; that switch is rejected in production. B03 accepts no client policy body and publishes only metadata from the verified runtime catalog. The authority endpoint requires an authenticated identity with the exact catalog-publication permission and never returns policy text, signatures, trust keys or client-supplied location. B127 additionally requires an independently signed deployment report proving this endpoint and readiness were observed over the controlled production origin.

B10 share authority is exposed only through `share-grant.get`, `share-grant.list`, and `share-grant.revoke`. A revoke call derives tenant, owner, work, export command and the original provider operation from persisted server state, creates one durable `revokeExport` command, and disables client sharing immediately. It reports `revoked` only after the gateway submits a signed terminal callback whose `targetProviderOperationId` matches that original grant. This second B10 operation means the 18 external-command batches resolve to 19 fixed signed callback contracts. Generic record create/update/delete is closed for every collection in that fixed external-command route inventory and for the five signed external-event reducer targets. Generic record reads of the two share-command collections are also closed so expired or revoked provider references can be obtained only through the safe share-grant projection.

Static files are served from `product/apps/web/public` by default, including SPA fallback. Only filenames containing an 8-64 character hexadecimal content hash receive immutable caching; HTML and unhashed assets use `no-cache`. Set `LTM_STATIC_DIR=disabled` to disable static serving or set an explicit directory.

The production web console never reads the public catalog to decide navigation.
It authenticates against `/v1/session` and consumes only
`ltm.visible-capability-manifest.v1` from `/v1/capabilities/visible`. That
projection is the intersection of the checked-in seven-portal/22-domain
manifest, the server-verified roles, and the exact permission enforced by each
of the 128 handlers. Its Authorization Code + PKCE S256 client persists only a
short-lived, single-use state/verifier transaction in `sessionStorage`; access
tokens remain in module memory and refresh tokens are rejected. Callback state,
expiry, exact redirect and configuration digest are revalidated before a
bounded CORS code exchange, the callback URL is cleared, and `/v1/session`
performs the authoritative JWT/JWKS validation. Without that verified session
the console fails closed.

## Production boundary

`APP_ENV=production` defaults to `LTM_DEPLOYMENT_PROFILE=distributed`. That profile requires `DATABASE_URL` with `sslmode=verify-full`, OIDC/JWKS authentication, trusted public evidence keys and protected metrics. Full-commercial production also requires the HTTPS origins `LTM_WECHAT_IDENTITY_BROKER_URL` and `LTM_UPLOAD_BROKER_URL`, plus absolute projected workload-token files in `LTM_WECHAT_IDENTITY_TOKEN_FILE` and `LTM_UPLOAD_BROKER_TOKEN_FILE`. The API rereads bounded, non-writable token files for every call, forwards only server-resolved tenant/actor context, validates closed broker responses, and includes both brokers in readiness. Inline broker secrets and unencrypted remote origins are rejected. Startup verifies the schema contract and rejects PostgreSQL superuser or `BYPASSRLS` roles. Every command, query and B00-B127 capability handler uses the same asynchronous runtime port. An intentionally limited single-node deployment must explicitly set `LTM_DEPLOYMENT_PROFILE=single-node` and `LTM_ALLOW_SINGLE_NODE_SQLITE=true`.

Run `node tools/release-gate.mjs --profile=production`. It exits blocked until a real B127 record, immutable manifest/SBOM, independent approvals and signed deployment reports are supplied. `node tools/backup-drill.mjs` remains the local SQLite restore check; production PostgreSQL backup/restore evidence must come from the deployed backup system and an independently observed restore drill.

The machine-readable contract is [openapi.yaml](./openapi.yaml). Identity and authorization fields are deliberately absent from request schemas because they are resolved from server-side bearer-token principals.

## Run

```sh
pnpm --filter @ltm/api test
LTM_AUTH_MODE=local-synthetic-only pnpm --filter @ltm/api start
```
