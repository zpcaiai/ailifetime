export const SCHEMA_VERSION = 1;

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
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'withdrawn', 'disputed', 'superseded')),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  is_minor INTEGER NOT NULL CHECK (is_minor IN (0, 1)),
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  withdrawn_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, id)
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
`;
