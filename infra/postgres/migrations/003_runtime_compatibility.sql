BEGIN;

CREATE TABLE IF NOT EXISTS ltm.schema_metadata (
  key text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO ltm.schema_metadata(key, value)
VALUES ('runtime_schema_version', '3')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

ALTER TABLE ltm.idempotency ADD COLUMN IF NOT EXISTS actor_id text;
UPDATE ltm.idempotency SET actor_id = 'legacy-migration' WHERE actor_id IS NULL;
ALTER TABLE ltm.idempotency ALTER COLUMN actor_id SET NOT NULL;

DO $$
DECLARE
  current_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_definition
  FROM pg_constraint
  WHERE conrelid = 'ltm.idempotency'::regclass AND contype = 'p';
  IF current_definition IS DISTINCT FROM 'PRIMARY KEY (tenant_id, actor_id, idempotency_key)' THEN
    ALTER TABLE ltm.idempotency DROP CONSTRAINT IF EXISTS idempotency_pkey;
    ALTER TABLE ltm.idempotency
      ADD CONSTRAINT idempotency_pkey PRIMARY KEY (tenant_id, actor_id, idempotency_key);
  END IF;
END;
$$;

ALTER TABLE ltm.inbox ADD COLUMN IF NOT EXISTS id text;
UPDATE ltm.inbox SET id = gen_random_uuid()::text WHERE id IS NULL;
ALTER TABLE ltm.inbox ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_tenant_id_idx ON ltm.inbox (tenant_id, id);

ALTER TABLE ltm.ledger_transactions
  ADD COLUMN IF NOT EXISTS request_fingerprint text;
UPDATE ltm.ledger_transactions
SET request_fingerprint = repeat('0', 64)
WHERE request_fingerprint IS NULL;
ALTER TABLE ltm.ledger_transactions ALTER COLUMN request_fingerprint SET NOT NULL;
ALTER TABLE ltm.ledger_transactions
  DROP CONSTRAINT IF EXISTS ledger_transactions_request_fingerprint_check;
ALTER TABLE ltm.ledger_transactions
  ADD CONSTRAINT ledger_transactions_request_fingerprint_check
  CHECK (request_fingerprint ~ '^[a-f0-9]{64}$');

-- Runtime roles receive DML grants from deployment tooling, never ownership.
-- FORCE RLS keeps table owners isolated as well; superuser/BYPASSRLS roles are
-- rejected by the runtime during startup.
ALTER TABLE ltm.idempotency FORCE ROW LEVEL SECURITY;
ALTER TABLE ltm.inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE ltm.ledger_transactions FORCE ROW LEVEL SECURITY;

COMMIT;
