BEGIN;

ALTER TABLE ltm.external_evidence
  ADD COLUMN IF NOT EXISTS canonical_claims_sha256 text,
  ADD COLUMN IF NOT EXISTS business_event_sha256 text;
ALTER TABLE ltm.external_evidence
  DROP CONSTRAINT IF EXISTS external_evidence_canonical_claims_sha256_check,
  DROP CONSTRAINT IF EXISTS external_evidence_business_event_sha256_check;
ALTER TABLE ltm.external_evidence
  ADD CONSTRAINT external_evidence_canonical_claims_sha256_check
    CHECK (canonical_claims_sha256 IS NULL OR canonical_claims_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT external_evidence_business_event_sha256_check
    CHECK (business_event_sha256 IS NULL OR business_event_sha256 ~ '^[a-f0-9]{64}$');

CREATE OR REPLACE FUNCTION ltm.reject_external_evidence_payload_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.envelope_version IS DISTINCT FROM OLD.envelope_version
     OR NEW.issuer IS DISTINCT FROM OLD.issuer
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
     OR NEW.canonical_claims_sha256 IS DISTINCT FROM OLD.canonical_claims_sha256
     OR NEW.business_event_sha256 IS DISTINCT FROM OLD.business_event_sha256
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.nonce IS DISTINCT FROM OLD.nonce
     OR NEW.replay_policy IS DISTINCT FROM OLD.replay_policy
     OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
     OR NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.signature IS DISTINCT FROM OLD.signature
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'verified external evidence payload is immutable';
  END IF;
  IF OLD.status <> 'verified'
     OR NEW.status <> 'revoked'
     OR NEW.version <> OLD.version + 1
     OR NEW.revoked_at IS NULL
     OR NEW.revocation_reason IS NULL
     OR length(NEW.revocation_reason) = 0 THEN
    RAISE EXCEPTION 'external evidence may only transition once from verified to revoked';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS ltm.external_commands (
  tenant_id text NOT NULL,
  command_id text NOT NULL,
  batch_id text NOT NULL,
  operation text NOT NULL,
  aggregate_collection text NOT NULL,
  aggregate_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('requested','dispatched','acknowledged','succeeded','failed','cancelled','compensated')),
  provider_operation_id text,
  evidence_id text,
  decision_state text NOT NULL DEFAULT 'active' CHECK (decision_state IN ('active','frozen')),
  reconciliation_state text NOT NULL DEFAULT 'clear' CHECK (reconciliation_state IN ('clear','reconciliation_required')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  terminal_at timestamptz,
  details jsonb NOT NULL,
  CHECK (
    (decision_state = 'active' AND reconciliation_state = 'clear')
    OR (decision_state = 'frozen' AND reconciliation_state = 'reconciliation_required')
  ),
  CHECK (
    (state IN ('succeeded','failed','cancelled','compensated') AND terminal_at IS NOT NULL)
    OR (state IN ('requested','dispatched','acknowledged') AND terminal_at IS NULL)
  ),
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id, aggregate_collection, aggregate_id)
    REFERENCES ltm.records(tenant_id, collection, id),
  FOREIGN KEY (tenant_id, evidence_id)
    REFERENCES ltm.external_evidence(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS external_commands_aggregate_idx
  ON ltm.external_commands(tenant_id, aggregate_collection, aggregate_id);

CREATE OR REPLACE FUNCTION ltm.guard_external_command_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.aggregate_collection IS DISTINCT FROM OLD.aggregate_collection
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id)
     OR (OLD.evidence_id IS NOT NULL AND NEW.evidence_id IS DISTINCT FROM OLD.evidence_id)
     OR NEW.version <> OLD.version + 1
     OR NOT (
       (NEW.decision_state = 'active' AND NEW.reconciliation_state = 'clear')
       OR (NEW.decision_state = 'frozen' AND NEW.reconciliation_state = 'reconciliation_required')
     ) THEN
    RAISE EXCEPTION 'external command identity is immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'requested' AND NEW.state IN ('dispatched','cancelled'))
    OR (OLD.state = 'dispatched' AND NEW.state IN ('acknowledged','failed','cancelled'))
    OR (OLD.state = 'acknowledged' AND NEW.state IN ('succeeded','failed','cancelled'))
    OR (OLD.state = 'succeeded' AND NEW.state = 'compensated')
  ) THEN
    RAISE EXCEPTION 'illegal external command transition';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS external_commands_update_guard ON ltm.external_commands;
CREATE TRIGGER external_commands_update_guard
  BEFORE UPDATE ON ltm.external_commands
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_external_command_update();

CREATE TABLE IF NOT EXISTS ltm.external_command_transitions (
  tenant_id text NOT NULL,
  transition_id text NOT NULL,
  command_id text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  provider_operation_id text,
  evidence_id text,
  details jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, transition_id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES ltm.external_commands(tenant_id, command_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES ltm.external_evidence(tenant_id, id)
);
DROP TRIGGER IF EXISTS external_command_transitions_immutable ON ltm.external_command_transitions;
CREATE TRIGGER external_command_transitions_immutable
  BEFORE UPDATE OR DELETE ON ltm.external_command_transitions
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();

CREATE TABLE IF NOT EXISTS ltm.evidence_decisions (
  tenant_id text NOT NULL,
  evidence_id text NOT NULL,
  decision_type text NOT NULL,
  decision_id text NOT NULL,
  aggregate_collection text NOT NULL,
  aggregate_id text NOT NULL,
  decision_state text NOT NULL DEFAULT 'active' CHECK (decision_state IN ('active','frozen')),
  reconciliation_state text NOT NULL DEFAULT 'clear' CHECK (reconciliation_state IN ('clear','reconciliation_required')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (decision_state = 'active' AND reconciliation_state = 'clear')
    OR (decision_state = 'frozen' AND reconciliation_state = 'reconciliation_required')
  ),
  PRIMARY KEY (tenant_id, evidence_id, decision_type, decision_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, aggregate_collection, aggregate_id)
    REFERENCES ltm.records(tenant_id, collection, id)
);
CREATE INDEX IF NOT EXISTS evidence_decisions_aggregate_idx
  ON ltm.evidence_decisions(tenant_id, aggregate_collection, aggregate_id);

CREATE OR REPLACE FUNCTION ltm.guard_evidence_decision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision_state <> 'active'
     OR NEW.decision_state <> 'frozen'
     OR NEW.reconciliation_state <> 'reconciliation_required'
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
     OR NEW.decision_type IS DISTINCT FROM OLD.decision_type
     OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
     OR NEW.aggregate_collection IS DISTINCT FROM OLD.aggregate_collection
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'evidence decisions may only freeze for reconciliation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evidence_decisions_freeze_only ON ltm.evidence_decisions;
CREATE TRIGGER evidence_decisions_freeze_only
  BEFORE UPDATE ON ltm.evidence_decisions
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_evidence_decision_update();

CREATE TABLE IF NOT EXISTS ltm.external_business_events (
  tenant_id text NOT NULL,
  provider text NOT NULL,
  event_id text NOT NULL,
  inbox_event_id text NOT NULL,
  event_fingerprint text NOT NULL CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
  batch_id text NOT NULL,
  operation text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  event_type text NOT NULL,
  provider_occurred_at timestamptz NOT NULL,
  provider_sequence bigint,
  correlation_id text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_id text NOT NULL,
  evidence_scope text NOT NULL,
  canonical_claims jsonb NOT NULL,
  canonical_claims_sha256 text NOT NULL CHECK (canonical_claims_sha256 ~ '^[a-f0-9]{64}$'),
  business_event_sha256 text NOT NULL CHECK (business_event_sha256 ~ '^[a-f0-9]{64}$'),
  reducer_name text NOT NULL,
  aggregate_collection text NOT NULL,
  aggregate_id text NOT NULL,
  prior_state text,
  next_state text NOT NULL,
  result_json jsonb NOT NULL,
  applied_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, provider, event_id),
  FOREIGN KEY (tenant_id, inbox_event_id) REFERENCES ltm.inbox(tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, aggregate_collection, aggregate_id)
    REFERENCES ltm.records(tenant_id, collection, id)
);
CREATE INDEX IF NOT EXISTS external_business_events_aggregate_idx
  ON ltm.external_business_events(
    tenant_id, aggregate_collection, aggregate_id, provider, provider_sequence, provider_occurred_at
  );
DROP TRIGGER IF EXISTS external_business_events_immutable ON ltm.external_business_events;
CREATE TRIGGER external_business_events_immutable
  BEFORE UPDATE OR DELETE ON ltm.external_business_events
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'external_commands','external_command_transitions','evidence_decisions','external_business_events'
  ] LOOP
    EXECUTE format('ALTER TABLE ltm.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE ltm.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON ltm.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON ltm.%I USING (tenant_id = ltm.current_tenant()) WITH CHECK (tenant_id = ltm.current_tenant())',
      table_name
    );
  END LOOP;
END;
$$;

INSERT INTO ltm.schema_metadata(key, value)
VALUES ('runtime_schema_version', '4')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
