BEGIN;

CREATE TABLE IF NOT EXISTS ltm.data_tracking_queue (
  tenant_id text NOT NULL,
  event_id text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  state text NOT NULL CHECK (state IN ('PENDING','IN_FLIGHT','DELIVERED','DEAD_LETTERED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 1000),
  next_attempt_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 512),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,event_id),
  CHECK (
    (state = 'IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR
    (state <> 'IN_FLIGHT' AND lease_owner IS NULL AND lease_until IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS data_tracking_due_idx
  ON ltm.data_tracking_queue(tenant_id,state,next_attempt_at,event_id)
  WHERE state IN ('PENDING','IN_FLIGHT');

CREATE OR REPLACE FUNCTION ltm.guard_data_tracking_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.envelope IS DISTINCT FROM OLD.envelope
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.attempts < OLD.attempts
     OR (OLD.state IN ('DELIVERED','DEAD_LETTERED') AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'invalid tracking queue mutation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS data_tracking_update_guard ON ltm.data_tracking_queue;
CREATE TRIGGER data_tracking_update_guard
  BEFORE UPDATE ON ltm.data_tracking_queue
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_data_tracking_update();

CREATE TABLE IF NOT EXISTS ltm.data_warehouse_state (
  tenant_id text NOT NULL,
  state_key text NOT NULL,
  state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,state_key)
);

CREATE OR REPLACE FUNCTION ltm.guard_data_warehouse_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.state_key IS DISTINCT FROM OLD.state_key
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid warehouse state CAS mutation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS data_warehouse_update_guard ON ltm.data_warehouse_state;
CREATE TRIGGER data_warehouse_update_guard
  BEFORE UPDATE ON ltm.data_warehouse_state
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_data_warehouse_update();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['data_tracking_queue','data_warehouse_state']
  LOOP
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
VALUES ('runtime_schema_version', '6')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
