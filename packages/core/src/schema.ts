export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS records (
  tenant_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  processing_purpose TEXT NOT NULL DEFAULT '__legacy_unmapped__',
  owner_actor_id TEXT,
  participant_ids_json TEXT NOT NULL DEFAULT '[]',
  contains_minor INTEGER NOT NULL DEFAULT 0 CHECK (contains_minor IN (0, 1)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, collection, id)
) STRICT;
CREATE INDEX IF NOT EXISTS records_tenant_collection_list
  ON records(tenant_id, collection, id);

CREATE TRIGGER IF NOT EXISTS records_tenant_immutable
BEFORE UPDATE OF tenant_id, collection, id ON records
BEGIN
  SELECT RAISE(ABORT, 'record identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS records_processing_purpose_immutable
BEFORE UPDATE OF processing_purpose ON records
BEGIN
  SELECT RAISE(ABORT, 'record processing purpose is immutable');
END;

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER IF NOT EXISTS idempotency_records_no_update
BEFORE UPDATE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS idempotency_records_no_delete
BEFORE DELETE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;

CREATE TABLE IF NOT EXISTS consents (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  grantor_actor_id TEXT NOT NULL,
  grantor_capacity TEXT NOT NULL CHECK (grantor_capacity IN ('self', 'guardian', 'authorized_agent')),
  purpose TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  policy_version TEXT NOT NULL,
  policy_catalog_sha256 TEXT CHECK (policy_catalog_sha256 IS NULL OR length(policy_catalog_sha256) = 64),
  jurisdiction TEXT,
  locale TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'withdrawn', 'disputed', 'superseded')),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  is_minor INTEGER NOT NULL CHECK (is_minor IN (0, 1)),
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  withdrawn_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, id),
  CHECK (
    (policy_catalog_sha256 IS NULL AND jurisdiction IS NULL AND locale IS NULL)
    OR
    (policy_catalog_sha256 IS NOT NULL AND jurisdiction IS NOT NULL AND length(jurisdiction) > 0
      AND locale IS NOT NULL AND length(locale) > 0)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS consents_active_lookup
  ON consents(tenant_id, participant_id, purpose, status, expires_at);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reversed_transaction_id TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_type, source_id),
  FOREIGN KEY (tenant_id, reversed_transaction_id)
    REFERENCES ledger_transactions(tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_single_reversal
  ON ledger_transactions(tenant_id, reversed_transaction_id)
  WHERE reversed_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_lines (
  tenant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number >= 0),
  account_code TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  memo TEXT,
  PRIMARY KEY (tenant_id, transaction_id, line_number),
  FOREIGN KEY (tenant_id, transaction_id)
    REFERENCES ledger_transactions(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ledger_lines_balance_lookup
  ON ledger_lines(tenant_id, account_code, currency);

CREATE TRIGGER IF NOT EXISTS ledger_transactions_no_update
BEFORE UPDATE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'posted ledger transactions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_transactions_no_delete
BEFORE DELETE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'posted ledger transactions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_lines_no_update
BEFORE UPDATE ON ledger_lines BEGIN SELECT RAISE(ABORT, 'posted ledger lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_lines_no_delete
BEFORE DELETE ON ledger_lines BEGIN SELECT RAISE(ABORT, 'posted ledger lines are immutable'); END;

CREATE TABLE IF NOT EXISTS inbox_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'rejected')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, source_event_id)
) STRICT;

CREATE TABLE IF NOT EXISTS outbox_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'published', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  last_error TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS outbox_delivery_lookup
  ON outbox_events(tenant_id, status, available_at, lease_until, created_at);

CREATE TABLE IF NOT EXISTS audit_entries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  request_id TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  previous_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS audit_entries_tenant_chain
  ON audit_entries(tenant_id, sequence);

CREATE TRIGGER IF NOT EXISTS audit_entries_no_update
BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_entries_no_delete
BEFORE DELETE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;

CREATE TABLE IF NOT EXISTS external_evidence (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  envelope_version TEXT NOT NULL CHECK (envelope_version = 'ltm.external-evidence.v1'),
  issuer TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'sandbox', 'staging', 'production')),
  scope TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  canonical_claims_sha256 TEXT CHECK (canonical_claims_sha256 IS NULL OR length(canonical_claims_sha256) = 64),
  business_event_sha256 TEXT CHECK (business_event_sha256 IS NULL OR length(business_event_sha256) = 64),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  nonce TEXT NOT NULL,
  replay_policy TEXT NOT NULL CHECK (replay_policy IN ('reusable', 'single_use')),
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  verified_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, issuer, provider, nonce),
  CHECK (
    (status = 'verified' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND length(revocation_reason) > 0)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS external_evidence_scope_lookup
  ON external_evidence(tenant_id, scope, status, expires_at);

DROP TRIGGER IF EXISTS external_evidence_payload_immutable;
CREATE TRIGGER external_evidence_payload_immutable
BEFORE UPDATE ON external_evidence
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.id IS NOT OLD.id
  OR NEW.envelope_version IS NOT OLD.envelope_version
  OR NEW.issuer IS NOT OLD.issuer
  OR NEW.provider IS NOT OLD.provider
  OR NEW.environment IS NOT OLD.environment
  OR NEW.scope IS NOT OLD.scope
  OR NEW.artifact_sha256 IS NOT OLD.artifact_sha256
  OR NEW.canonical_claims_sha256 IS NOT OLD.canonical_claims_sha256
  OR NEW.business_event_sha256 IS NOT OLD.business_event_sha256
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.nonce IS NOT OLD.nonce
  OR NEW.replay_policy IS NOT OLD.replay_policy
  OR NEW.algorithm IS NOT OLD.algorithm
  OR NEW.key_id IS NOT OLD.key_id
  OR NEW.signature IS NOT OLD.signature
  OR NEW.verified_at IS NOT OLD.verified_at
BEGIN SELECT RAISE(ABORT, 'verified evidence payload is immutable'); END;
DROP TRIGGER IF EXISTS external_evidence_revoke_only;
CREATE TRIGGER external_evidence_revoke_only
BEFORE UPDATE ON external_evidence
WHEN OLD.status <> 'verified'
  OR NEW.status <> 'revoked'
  OR NEW.version <> OLD.version + 1
  OR NEW.revoked_at IS NULL
  OR NEW.revocation_reason IS NULL
  OR length(NEW.revocation_reason) = 0
BEGIN SELECT RAISE(ABORT, 'external evidence may only transition once from verified to revoked'); END;
CREATE TRIGGER IF NOT EXISTS external_evidence_no_delete
BEFORE DELETE ON external_evidence BEGIN SELECT RAISE(ABORT, 'external evidence is append-only'); END;

CREATE TABLE IF NOT EXISTS evidence_consumptions (
  tenant_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  consumption_key_hash TEXT NOT NULL CHECK (length(consumption_key_hash) = 64),
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, evidence_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS evidence_consumptions_no_update
BEFORE UPDATE ON evidence_consumptions BEGIN SELECT RAISE(ABORT, 'evidence consumption is immutable'); END;
CREATE TRIGGER IF NOT EXISTS evidence_consumptions_no_delete
BEFORE DELETE ON evidence_consumptions BEGIN SELECT RAISE(ABORT, 'evidence consumption is immutable'); END;

CREATE TABLE IF NOT EXISTS participants (
  tenant_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  minor_status TEXT NOT NULL CHECK (minor_status IN ('adult', 'minor')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  evidence_id TEXT NOT NULL,
  evidence_scope TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  revocation_evidence_id TEXT,
  revocation_evidence_scope TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, participant_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, revocation_evidence_id) REFERENCES external_evidence(tenant_id, id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL
      AND revocation_evidence_id IS NULL AND revocation_evidence_scope IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(revocation_reason) > 0
      AND revocation_evidence_id IS NOT NULL AND revocation_evidence_scope IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS participants_owner_lookup
  ON participants(tenant_id, owner_actor_id, status, expires_at);
CREATE TRIGGER IF NOT EXISTS participants_update_guard
BEFORE UPDATE ON participants
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.version <> OLD.version + 1
  OR (OLD.status = 'revoked' AND NEW.status <> 'active')
  OR (OLD.status = 'active' AND NEW.status NOT IN ('active', 'revoked'))
BEGIN SELECT RAISE(ABORT, 'invalid participant registry transition'); END;
CREATE TRIGGER IF NOT EXISTS participants_no_delete
BEFORE DELETE ON participants BEGIN SELECT RAISE(ABORT, 'participant registry entries are durable'); END;

CREATE TABLE IF NOT EXISTS guardian_authorizations (
  tenant_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  guardian_actor_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  evidence_id TEXT NOT NULL,
  evidence_scope TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  revocation_evidence_id TEXT,
  revocation_evidence_scope TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, authorization_id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, participant_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, revocation_evidence_id) REFERENCES external_evidence(tenant_id, id),
  CHECK (
    (status IN ('active', 'superseded') AND revoked_at IS NULL AND revocation_reason IS NULL
      AND revocation_evidence_id IS NULL AND revocation_evidence_scope IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(revocation_reason) > 0
      AND revocation_evidence_id IS NOT NULL AND revocation_evidence_scope IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS guardian_authorizations_active_lookup
  ON guardian_authorizations(tenant_id, guardian_actor_id, participant_id, status, expires_at);
CREATE TRIGGER IF NOT EXISTS guardian_authorizations_update_guard
BEFORE UPDATE ON guardian_authorizations
WHEN OLD.status <> 'active'
  OR NEW.status NOT IN ('revoked', 'superseded')
  OR NEW.version <> OLD.version + 1
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.authorization_id IS NOT OLD.authorization_id
  OR NEW.guardian_actor_id IS NOT OLD.guardian_actor_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.scope_json IS NOT OLD.scope_json
  OR NEW.evidence_id IS NOT OLD.evidence_id
  OR NEW.evidence_scope IS NOT OLD.evidence_scope
  OR NEW.granted_at IS NOT OLD.granted_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'invalid guardian authorization transition'); END;
CREATE TRIGGER IF NOT EXISTS guardian_authorizations_no_delete
BEFORE DELETE ON guardian_authorizations BEGIN SELECT RAISE(ABORT, 'guardian authorizations are durable'); END;

CREATE TABLE IF NOT EXISTS authorized_agent_authorizations (
  tenant_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  agent_actor_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  evidence_id TEXT NOT NULL,
  evidence_scope TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  revocation_evidence_id TEXT,
  revocation_evidence_scope TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, authorization_id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, participant_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, revocation_evidence_id) REFERENCES external_evidence(tenant_id, id),
  CHECK (
    (status IN ('active', 'superseded') AND revoked_at IS NULL AND revocation_reason IS NULL
      AND revocation_evidence_id IS NULL AND revocation_evidence_scope IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(revocation_reason) > 0
      AND revocation_evidence_id IS NOT NULL AND revocation_evidence_scope IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS authorized_agent_authorizations_active_lookup
  ON authorized_agent_authorizations(tenant_id, agent_actor_id, participant_id, status, expires_at);
CREATE TRIGGER IF NOT EXISTS authorized_agent_authorizations_update_guard
BEFORE UPDATE ON authorized_agent_authorizations
WHEN OLD.status <> 'active'
  OR NEW.status NOT IN ('revoked', 'superseded')
  OR NEW.version <> OLD.version + 1
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.authorization_id IS NOT OLD.authorization_id
  OR NEW.agent_actor_id IS NOT OLD.agent_actor_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.scope_json IS NOT OLD.scope_json
  OR NEW.evidence_id IS NOT OLD.evidence_id
  OR NEW.evidence_scope IS NOT OLD.evidence_scope
  OR NEW.granted_at IS NOT OLD.granted_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'invalid authorized-agent authorization transition'); END;
CREATE TRIGGER IF NOT EXISTS authorized_agent_authorizations_no_delete
BEFORE DELETE ON authorized_agent_authorizations BEGIN SELECT RAISE(ABORT, 'authorized-agent authorizations are durable'); END;

CREATE TABLE IF NOT EXISTS external_commands (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  aggregate_collection TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested','dispatched','acknowledged','succeeded','failed','cancelled','compensated')),
  provider_operation_id TEXT,
  evidence_id TEXT,
  decision_state TEXT NOT NULL DEFAULT 'active' CHECK (decision_state IN ('active','frozen')),
  reconciliation_state TEXT NOT NULL DEFAULT 'clear' CHECK (reconciliation_state IN ('clear','reconciliation_required')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  CHECK (
    (decision_state = 'active' AND reconciliation_state = 'clear')
    OR (decision_state = 'frozen' AND reconciliation_state = 'reconciliation_required')
  ),
  CHECK (
    (state IN ('succeeded','failed','cancelled','compensated') AND terminal_at IS NOT NULL)
    OR (state IN ('requested','dispatched','acknowledged') AND terminal_at IS NULL)
  ),
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id, aggregate_collection, aggregate_id) REFERENCES records(tenant_id, collection, id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS external_commands_aggregate_lookup
  ON external_commands(tenant_id, aggregate_collection, aggregate_id);

CREATE TRIGGER IF NOT EXISTS external_commands_identity_immutable
BEFORE UPDATE ON external_commands
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.command_id IS NOT OLD.command_id
  OR NEW.batch_id IS NOT OLD.batch_id
  OR NEW.operation IS NOT OLD.operation
  OR NEW.aggregate_collection IS NOT OLD.aggregate_collection
  OR NEW.aggregate_id IS NOT OLD.aggregate_id
  OR NEW.requested_at IS NOT OLD.requested_at
  OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS NOT OLD.provider_operation_id)
  OR (OLD.evidence_id IS NOT NULL AND NEW.evidence_id IS NOT OLD.evidence_id)
  OR NEW.version <> OLD.version + 1
  OR NOT (
    (NEW.decision_state = 'active' AND NEW.reconciliation_state = 'clear')
    OR (NEW.decision_state = 'frozen' AND NEW.reconciliation_state = 'reconciliation_required')
  )
BEGIN SELECT RAISE(ABORT, 'external command identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS external_commands_transition_guard
BEFORE UPDATE OF state ON external_commands
WHEN NOT (
  (OLD.state = 'requested' AND NEW.state IN ('dispatched','cancelled'))
  OR (OLD.state = 'dispatched' AND NEW.state IN ('acknowledged','failed','cancelled'))
  OR (OLD.state = 'acknowledged' AND NEW.state IN ('succeeded','failed','cancelled'))
  OR (OLD.state = 'succeeded' AND NEW.state = 'compensated')
)
BEGIN SELECT RAISE(ABORT, 'illegal external command transition'); END;

CREATE TABLE IF NOT EXISTS external_command_transitions (
  tenant_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  provider_operation_id TEXT,
  evidence_id TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, transition_id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES external_commands(tenant_id, command_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS external_command_transitions_no_update
BEFORE UPDATE ON external_command_transitions BEGIN SELECT RAISE(ABORT, 'external command transitions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS external_command_transitions_no_delete
BEFORE DELETE ON external_command_transitions BEGIN SELECT RAISE(ABORT, 'external command transitions are immutable'); END;

CREATE TABLE IF NOT EXISTS evidence_decisions (
  tenant_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  aggregate_collection TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  decision_state TEXT NOT NULL DEFAULT 'active' CHECK (decision_state IN ('active','frozen')),
  reconciliation_state TEXT NOT NULL DEFAULT 'clear' CHECK (reconciliation_state IN ('clear','reconciliation_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (decision_state = 'active' AND reconciliation_state = 'clear')
    OR (decision_state = 'frozen' AND reconciliation_state = 'reconciliation_required')
  ),
  PRIMARY KEY (tenant_id, evidence_id, decision_type, decision_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, aggregate_collection, aggregate_id) REFERENCES records(tenant_id, collection, id)
) STRICT;
CREATE INDEX IF NOT EXISTS evidence_decisions_aggregate_lookup
  ON evidence_decisions(tenant_id, aggregate_collection, aggregate_id);
CREATE TRIGGER IF NOT EXISTS evidence_decisions_freeze_only
BEFORE UPDATE ON evidence_decisions
WHEN OLD.decision_state <> 'active'
  OR NEW.decision_state <> 'frozen'
  OR NEW.reconciliation_state <> 'reconciliation_required'
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.evidence_id IS NOT OLD.evidence_id
  OR NEW.decision_type IS NOT OLD.decision_type
  OR NEW.decision_id IS NOT OLD.decision_id
  OR NEW.aggregate_collection IS NOT OLD.aggregate_collection
  OR NEW.aggregate_id IS NOT OLD.aggregate_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'evidence decisions may only freeze for reconciliation'); END;

CREATE TABLE IF NOT EXISTS external_business_events (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  inbox_event_id TEXT NOT NULL,
  event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 64),
  batch_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_occurred_at TEXT NOT NULL,
  provider_sequence INTEGER,
  correlation_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  evidence_id TEXT NOT NULL,
  evidence_scope TEXT NOT NULL,
  canonical_claims_json TEXT NOT NULL CHECK (json_valid(canonical_claims_json)),
  canonical_claims_sha256 TEXT NOT NULL CHECK (length(canonical_claims_sha256) = 64),
  business_event_sha256 TEXT NOT NULL CHECK (length(business_event_sha256) = 64),
  reducer_name TEXT NOT NULL,
  aggregate_collection TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  prior_state TEXT,
  next_state TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider, event_id),
  FOREIGN KEY (tenant_id, inbox_event_id) REFERENCES inbox_events(tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, aggregate_collection, aggregate_id) REFERENCES records(tenant_id, collection, id)
) STRICT;
CREATE INDEX IF NOT EXISTS external_business_events_aggregate_order
  ON external_business_events(tenant_id, aggregate_collection, aggregate_id, provider, provider_sequence, provider_occurred_at);
CREATE TRIGGER IF NOT EXISTS external_business_events_no_update
BEFORE UPDATE ON external_business_events BEGIN SELECT RAISE(ABORT, 'external business events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS external_business_events_no_delete
BEFORE DELETE ON external_business_events BEGIN SELECT RAISE(ABORT, 'external business events are immutable'); END;

UPDATE schema_metadata SET value = '${SCHEMA_VERSION}'
WHERE key = 'schema_version' AND value IN ('1', '2', '3', '4');
`;
