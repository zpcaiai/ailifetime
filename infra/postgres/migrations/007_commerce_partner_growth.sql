BEGIN;

CREATE SCHEMA IF NOT EXISTS orchestration;

CREATE TABLE IF NOT EXISTS orchestration.workflow_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  definition_id text NOT NULL,
  definition_version integer NOT NULL CHECK (definition_version > 0),
  idempotency_key text NOT NULL,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, definition_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS orchestration.outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  state text NOT NULL CHECK (state IN ('pending','delivering','delivered','dead_letter')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at timestamptz NOT NULL,
  receipt_sha256 text CHECK (receipt_sha256 IS NULL OR receipt_sha256 ~ '^[a-f0-9]{64}$'),
  reason_code text,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS orchestration_outbox_due_idx ON orchestration.outbox (tenant_id, state, next_attempt_at);
CREATE TABLE IF NOT EXISTS orchestration.inbox (
  tenant_id text NOT NULL,
  message_id text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, message_id)
);
CREATE TABLE IF NOT EXISTS orchestration.dead_letters (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  reason_code text NOT NULL,
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  quarantined_at timestamptz NOT NULL,
  replayed_at timestamptz
);
CREATE TABLE IF NOT EXISTS orchestration.provider_executions (
  idempotency_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration.late_provider_results (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  provider_id text NOT NULL,
  provider_operation_id text NOT NULL,
  provider_idempotency_key text NOT NULL,
  output_artifact_sha256 text NOT NULL CHECK (output_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('DELETED','QUARANTINED')),
  deletion_receipt_sha256 text CHECK (deletion_receipt_sha256 IS NULL OR deletion_receipt_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS orchestration.workflow_history (
  workflow_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  tenant_id text NOT NULL,
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (workflow_id, sequence)
);
CREATE TABLE IF NOT EXISTS orchestration.scheduler_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  kind text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  due_at timestamptz NOT NULL,
  interval_ms bigint,
  last_enqueued_at timestamptz
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workflow_instances','outbox','inbox','dead_letters','provider_executions','late_provider_results','workflow_history','scheduler_jobs'] LOOP
    EXECUTE format('ALTER TABLE orchestration.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE orchestration.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON orchestration.%I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON orchestration.%I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', table_name);
  END LOOP;
END;
$$;

-- Durable state projections for the commerce, growth, and partner bounded
-- contexts. The JSON state is an implementation projection; append-only
-- tables below retain the independently auditable facts emitted by each
-- transaction. Every table is tenant/partner scoped and RLS protected.
CREATE TABLE IF NOT EXISTS ltm.commerce_finance_state (
  tenant_id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS ltm.growth_operations_state (
  tenant_id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS ltm.partner_settlement_state (
  partner_id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ltm.referral_rewards (
  tenant_id text NOT NULL,
  id text NOT NULL,
  source_key text NOT NULL,
  source_order_id text NOT NULL,
  referral_id text NOT NULL,
  beneficiary_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('credit','cash_commission','partner_share','reversal')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reverses_reward_id text,
  occurred_at timestamptz NOT NULL,
  entry_sha256 text NOT NULL CHECK (entry_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_key)
);
CREATE TABLE IF NOT EXISTS ltm.lifecycle_deliveries (
  tenant_id text NOT NULL,
  message_id text NOT NULL,
  account_id text NOT NULL,
  message_class text NOT NULL,
  channel text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, message_id)
);
CREATE TABLE IF NOT EXISTS ltm.partner_usage_events (
  partner_id text NOT NULL,
  id text NOT NULL,
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (partner_id, id),
  UNIQUE (partner_id, event_sha256)
);
CREATE TABLE IF NOT EXISTS ltm.partner_rate_contracts (
  partner_id text NOT NULL,
  contract_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  payload jsonb NOT NULL,
  PRIMARY KEY (partner_id, contract_id, version)
);
CREATE TABLE IF NOT EXISTS ltm.partner_settlement_statements (
  partner_id text NOT NULL,
  id text NOT NULL,
  period text NOT NULL,
  amount_minor bigint NOT NULL,
  state text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (partner_id, id)
);
CREATE TABLE IF NOT EXISTS ltm.partner_anomaly_decisions (
  partner_id text NOT NULL,
  statement_id text NOT NULL,
  anomaly text NOT NULL,
  decision text NOT NULL,
  decided_by text NOT NULL,
  reason text NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  decided_at timestamptz NOT NULL,
  waiver_expires_at timestamptz,
  PRIMARY KEY (partner_id, statement_id, anomaly)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commerce_finance_state','growth_operations_state','partner_settlement_state','referral_rewards',
    'lifecycle_deliveries','partner_usage_events','partner_rate_contracts',
    'partner_settlement_statements','partner_anomaly_decisions'
  ] LOOP
    EXECUTE format('ALTER TABLE ltm.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE ltm.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON ltm.%I', table_name);
    IF table_name LIKE 'partner_%' THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON ltm.%I USING (partner_id = current_setting(''app.partner_id'', true)) WITH CHECK (partner_id = current_setting(''app.partner_id'', true))', table_name);
    ELSE
      EXECUTE format('CREATE POLICY tenant_isolation ON ltm.%I USING (tenant_id = ltm.current_tenant()) WITH CHECK (tenant_id = ltm.current_tenant())', table_name);
    END IF;
  END LOOP;
END;
$$;

INSERT INTO ltm.schema_metadata(key, value)
VALUES ('runtime_schema_version', '7')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
