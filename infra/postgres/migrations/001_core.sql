BEGIN;

CREATE SCHEMA IF NOT EXISTS ltm;

CREATE TABLE IF NOT EXISTS ltm.records (
  tenant_id text NOT NULL,
  collection text NOT NULL,
  id text NOT NULL,
  owner_actor_id text,
  participant_ids text[] NOT NULL DEFAULT '{}',
  contains_minor boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, collection, id)
);

CREATE INDEX IF NOT EXISTS records_owner_idx ON ltm.records (tenant_id, owner_actor_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS records_participants_idx ON ltm.records USING gin (participant_ids) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ltm.consents (
  tenant_id text NOT NULL,
  id text NOT NULL,
  participant_id text NOT NULL,
  grantor_actor_id text NOT NULL,
  grantor_capacity text NOT NULL CHECK (grantor_capacity IN ('self', 'guardian', 'authorized_agent')),
  purpose text NOT NULL,
  scope jsonb NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'withdrawn', 'disputed', 'superseded')),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  is_minor boolean NOT NULL DEFAULT false,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz,
  withdrawn_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS active_consent_lookup_idx ON ltm.consents (tenant_id, participant_id, purpose, expires_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ltm.idempotency (
  tenant_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ltm.inbox (
  tenant_id text NOT NULL,
  source text NOT NULL,
  source_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('received', 'processed', 'rejected')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, source, source_event_id)
);

CREATE TABLE IF NOT EXISTS ltm.outbox (
  tenant_id text NOT NULL,
  id text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'published', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS outbox_dispatch_idx ON ltm.outbox (status, available_at) WHERE status IN ('pending', 'leased');

CREATE TABLE IF NOT EXISTS ltm.audit_log (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  purpose text NOT NULL,
  request_id text NOT NULL,
  details jsonb NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS audit_tenant_sequence_idx ON ltm.audit_log (tenant_id, sequence);

CREATE TABLE IF NOT EXISTS ltm.ledger_transactions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  description text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversed_transaction_id text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS ltm.ledger_lines (
  tenant_id text NOT NULL,
  transaction_id text NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  account_code text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  memo text,
  PRIMARY KEY (tenant_id, transaction_id, line_no),
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES ltm.ledger_transactions (tenant_id, id)
);

CREATE OR REPLACE FUNCTION ltm.reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable financial or audit records cannot be changed';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_immutable ON ltm.audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON ltm.audit_log FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();
DROP TRIGGER IF EXISTS ledger_transactions_immutable ON ltm.ledger_transactions;
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ltm.ledger_transactions FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();
DROP TRIGGER IF EXISTS ledger_lines_immutable ON ltm.ledger_lines;
CREATE TRIGGER ledger_lines_immutable BEFORE UPDATE OR DELETE ON ltm.ledger_lines FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();

CREATE OR REPLACE FUNCTION ltm.assert_balanced_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unbalanced_count integer;
BEGIN
  SELECT count(*) INTO unbalanced_count
  FROM (
    SELECT currency
    FROM ltm.ledger_lines
    WHERE tenant_id = NEW.tenant_id AND transaction_id = NEW.transaction_id
    GROUP BY currency
    HAVING sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0
  ) balances;
  IF unbalanced_count <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced', NEW.transaction_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledger_lines_balanced ON ltm.ledger_lines;
CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON ltm.ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ltm.assert_balanced_transaction();

ALTER TABLE ltm.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.ledger_lines ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION ltm.current_tenant() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['records','consents','idempotency','inbox','outbox','audit_log','ledger_transactions','ledger_lines']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON ltm.%I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON ltm.%I USING (tenant_id = ltm.current_tenant()) WITH CHECK (tenant_id = ltm.current_tenant())', table_name);
    EXECUTE format('ALTER TABLE ltm.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;

COMMIT;
