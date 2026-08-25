BEGIN;

ALTER TABLE ltm.records ADD COLUMN IF NOT EXISTS processing_purpose text;
UPDATE ltm.records
SET processing_purpose = CASE
  WHEN jsonb_typeof(data->'purpose') = 'string'
    AND length(btrim(data->>'purpose')) BETWEEN 1 AND 120
    AND (data->>'purpose') !~ '[[:cntrl:]]'
    AND btrim(data->>'purpose') <> '__legacy_unmapped__'
  THEN btrim(data->>'purpose')
  ELSE '__legacy_unmapped__'
END
WHERE processing_purpose IS NULL;
ALTER TABLE ltm.records ALTER COLUMN processing_purpose SET NOT NULL;
ALTER TABLE ltm.records DROP CONSTRAINT IF EXISTS records_processing_purpose_check;
ALTER TABLE ltm.records ADD CONSTRAINT records_processing_purpose_check
  CHECK (length(processing_purpose) BETWEEN 1 AND 120 AND processing_purpose !~ '[[:cntrl:]]');

CREATE OR REPLACE FUNCTION ltm.guard_record_processing_purpose() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.processing_purpose IS DISTINCT FROM OLD.processing_purpose THEN
    RAISE EXCEPTION 'record processing purpose is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS records_processing_purpose_immutable ON ltm.records;
CREATE TRIGGER records_processing_purpose_immutable
  BEFORE UPDATE OF processing_purpose ON ltm.records
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_record_processing_purpose();

CREATE TABLE IF NOT EXISTS ltm.participants (
  tenant_id text NOT NULL,
  participant_id text NOT NULL,
  owner_actor_id text NOT NULL,
  minor_status text NOT NULL CHECK (minor_status IN ('adult', 'minor')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  evidence_id text NOT NULL,
  evidence_scope text NOT NULL,
  registered_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  revocation_evidence_id text,
  revocation_evidence_scope text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, participant_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, revocation_evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL
      AND revocation_evidence_id IS NULL AND revocation_evidence_scope IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(revocation_reason) > 0
      AND revocation_evidence_id IS NOT NULL AND revocation_evidence_scope IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS participants_owner_idx
  ON ltm.participants(tenant_id, owner_actor_id, status, expires_at);

CREATE TABLE IF NOT EXISTS ltm.guardian_authorizations (
  tenant_id text NOT NULL,
  authorization_id text NOT NULL,
  guardian_actor_id text NOT NULL,
  participant_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  scope jsonb NOT NULL,
  evidence_id text NOT NULL,
  evidence_scope text NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  revocation_evidence_id text,
  revocation_evidence_scope text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, authorization_id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES ltm.participants(tenant_id, participant_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, revocation_evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  CHECK (
    (status IN ('active', 'superseded') AND revoked_at IS NULL AND revocation_reason IS NULL
      AND revocation_evidence_id IS NULL AND revocation_evidence_scope IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(revocation_reason) > 0
      AND revocation_evidence_id IS NOT NULL AND revocation_evidence_scope IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS guardian_authorizations_active_idx
  ON ltm.guardian_authorizations(tenant_id, guardian_actor_id, participant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS ltm.authorized_agent_authorizations (
  tenant_id text NOT NULL,
  authorization_id text NOT NULL,
  agent_actor_id text NOT NULL,
  participant_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  scope jsonb NOT NULL,
  evidence_id text NOT NULL,
  evidence_scope text NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  revocation_evidence_id text,
  revocation_evidence_scope text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, authorization_id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES ltm.participants(tenant_id, participant_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  FOREIGN KEY (tenant_id, revocation_evidence_id) REFERENCES ltm.external_evidence(tenant_id, id),
  CHECK (
    (status IN ('active', 'superseded') AND revoked_at IS NULL AND revocation_reason IS NULL
      AND revocation_evidence_id IS NULL AND revocation_evidence_scope IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(revocation_reason) > 0
      AND revocation_evidence_id IS NOT NULL AND revocation_evidence_scope IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS authorized_agent_authorizations_active_idx
  ON ltm.authorized_agent_authorizations(tenant_id, agent_actor_id, participant_id, status, expires_at);

CREATE OR REPLACE FUNCTION ltm.guard_participant_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.version <> OLD.version + 1
     OR (OLD.status = 'revoked' AND NEW.status <> 'active')
     OR (OLD.status = 'active' AND NEW.status NOT IN ('active', 'revoked')) THEN
    RAISE EXCEPTION 'invalid participant registry transition';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS participants_update_guard ON ltm.participants;
CREATE TRIGGER participants_update_guard
  BEFORE UPDATE ON ltm.participants
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_participant_update();
DROP TRIGGER IF EXISTS participants_no_delete ON ltm.participants;
CREATE TRIGGER participants_no_delete
  BEFORE DELETE ON ltm.participants
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();

CREATE OR REPLACE FUNCTION ltm.guard_participant_authority_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'active'
     OR NEW.status NOT IN ('revoked', 'superseded')
     OR NEW.version <> OLD.version + 1
     OR (to_jsonb(NEW) - ARRAY['status','version','revoked_at','revocation_reason','revocation_evidence_id','revocation_evidence_scope'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status','version','revoked_at','revocation_reason','revocation_evidence_id','revocation_evidence_scope']) THEN
    RAISE EXCEPTION 'invalid participant authority transition';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guardian_authorizations_update_guard ON ltm.guardian_authorizations;
CREATE TRIGGER guardian_authorizations_update_guard
  BEFORE UPDATE ON ltm.guardian_authorizations
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_participant_authority_update();
DROP TRIGGER IF EXISTS guardian_authorizations_no_delete ON ltm.guardian_authorizations;
CREATE TRIGGER guardian_authorizations_no_delete
  BEFORE DELETE ON ltm.guardian_authorizations
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();
DROP TRIGGER IF EXISTS authorized_agent_authorizations_update_guard ON ltm.authorized_agent_authorizations;
CREATE TRIGGER authorized_agent_authorizations_update_guard
  BEFORE UPDATE ON ltm.authorized_agent_authorizations
  FOR EACH ROW EXECUTE FUNCTION ltm.guard_participant_authority_update();
DROP TRIGGER IF EXISTS authorized_agent_authorizations_no_delete ON ltm.authorized_agent_authorizations;
CREATE TRIGGER authorized_agent_authorizations_no_delete
  BEFORE DELETE ON ltm.authorized_agent_authorizations
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['participants','guardian_authorizations','authorized_agent_authorizations']
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

ALTER TABLE ltm.consents ADD COLUMN IF NOT EXISTS policy_catalog_sha256 text;
ALTER TABLE ltm.consents ADD COLUMN IF NOT EXISTS jurisdiction text;
ALTER TABLE ltm.consents ADD COLUMN IF NOT EXISTS locale text;
ALTER TABLE ltm.consents DROP CONSTRAINT IF EXISTS consents_policy_catalog_binding_check;
ALTER TABLE ltm.consents ADD CONSTRAINT consents_policy_catalog_binding_check CHECK (
  (policy_catalog_sha256 IS NULL AND jurisdiction IS NULL AND locale IS NULL)
  OR
  (policy_catalog_sha256 ~ '^[a-f0-9]{64}$'
    AND length(jurisdiction) BETWEEN 2 AND 32
    AND length(locale) BETWEEN 2 AND 16)
);

INSERT INTO ltm.schema_metadata(key, value)
VALUES ('runtime_schema_version', '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
