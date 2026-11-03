-- Separate additive migration. Run with the deployment migrator, never at request time.
CREATE SCHEMA IF NOT EXISTS photo_service;
CREATE TABLE IF NOT EXISTS photo_service.generations (
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('executing','succeeded','reconciliation_required')),
  asset jsonb,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id, idempotency_key),
  CHECK ((state = 'succeeded') = (asset IS NOT NULL AND generated_at IS NOT NULL))
);
