# Production outbox worker

`@ltm/workers` is an independently deployable outbox process. It claims leased events, routes them to one of `media`, `notification`, `fulfillment`, `integration` or `data`, signs the exact request body, reuses the outbox event ID as provider idempotency key, and retries with bounded backoff. Missing routes or batch adapters fail closed.

Before an ordinary record snapshot crosses the network, the worker re-reads that exact aggregate through the runtime service actor. This re-evaluates the current processing purpose, participant/guardian authority and consent. The event identity and complete same-version snapshot must match durable state byte-for-value; a corrupt mismatch fails closed. If a newer version already superseded the queued snapshot, the worker records `outbox.stale_projection_skipped` and does not disclose the stale payload. External-command projections remain suppressed in favor of their single purpose-built command intent.

External commands have one side-effecting outbox event: `external_command.requested`. The worker persists `dispatched` before calling a provider and records `acknowledged` only after validating the provider's signed response. Aggregate create/update and later lifecycle events cannot trigger another delivery. A response loss is retried with the same provider idempotency key. `succeeded`, `failed`, `cancelled` and `compensated` are accepted only from the signed callback/business-event transaction; an outbound HTTP acceptance never becomes commercial success.

The service actor is always `service_account` with only `outbox:read`, `outbox:publish`, `record:read`, audited `record:purpose:cross`, `external-command:read`, `external-command:transition` and `audit:append`. The cross-purpose grant is needed only to deliver records under their immutable stored purpose; the runtime still enforces the record's exact participant consent before returning data. It never runs as `platform_admin`.

## Production configuration

Set `APP_ENV=production`, `LTM_DEPLOYMENT_PROFILE=distributed`, a least-privilege `DATABASE_URL` ending in `sslmode=verify-full`, `LTM_WORKER_TENANT_ID` and `LTM_WORKER_ID`. The worker and API then share the PostgreSQL outbox; `LTM_DATABASE_PATH` is rejected in this profile. SQLite remains a single-node development option and production requires the explicit `LTM_ALLOW_SINGLE_NODE_SQLITE=true` risk acceptance. `LTM_OUTBOX_ROUTE_ADAPTERS_JSON` must map all five route names. `LTM_EXTERNAL_COMMAND_ADAPTERS_JSON` maps these 18 batches; the B10 adapter serves two fixed operations (`publishExport` and server-derived `revokeExport`), so these adapters cover 19 signed callback route contracts:

`B05,B10,B13,B14,B16,B23,B26,B29,B36,B38,B40,B65,B67,B74,B83,B89,B98,B101`

Each entry has this shape:

```json
{
  "endpoint": "https://provider.example.com/ltm/commands",
  "signingSecretReference": "secret-manager:ltm/production/provider-hmac",
  "responseVerificationKeyReference": "secret-manager:ltm/production/provider-response-key",
  "responseSignatureScheme": "hmac-sha256",
  "timeoutMs": 10000
}
```

Only credential-free HTTPS endpoints and `secret-manager:` references are accepted. Every provider receipt must use `ltm-provider-receipt.v2`, repeat the exact outbound request SHA-256 in both its signed headers and JSON body, and carry an exact-response-body HMAC-SHA256, Ed25519 or ES256 signature, a bounded timestamp and the original idempotency key. The v2 signature covers both request and response digests, preventing an accepted receipt for the same idempotency key from being attached to different command bytes. AWS credentials come from the workload identity or instance role; raw keys are never accepted in configuration. Production refuses partial route or batch maps at startup.

Production also requires `LTM_METRICS_TOKEN_SHA256`; only the bearer-token hash is stored. The worker exposes `/health/live`, `/health/ready` and protected Prometheus `/metrics` on `LTM_WORKER_HEALTH_HOST`/`LTM_WORKER_HEALTH_PORT` (defaults `0.0.0.0:8090`).

Every worker runtime uses the same signed consent-policy loader as the API. Staging and production require `LTM_CONSENT_POLICY_CATALOG_FILE`, `LTM_CONSENT_POLICY_TRUST_KEYS_JSON`, `LTM_CONSENT_POLICY_JURISDICTION`, and `LTM_CONSENT_POLICY_LOCALE`; the catalog is read as a bounded non-symlink regular file and verified against an active Ed25519 public key before the database opens. Development configuration explicitly selects legacy-test-only consent semantics when no signed catalog is supplied. Legacy mode is rejected in staging/production and cannot accompany a signed catalog. `/health/ready` includes the runtime's `consentPolicy` result, so a missing, expired, revoked, environment-mismatched or invalid policy cannot appear healthy.

After building, start with `pnpm --filter @ltm/workers start`. SIGINT and SIGTERM stop new polling, close the health listener and close the database after the current leased batch.
