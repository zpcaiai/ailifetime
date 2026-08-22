BEGIN;

CREATE TABLE IF NOT EXISTS ltm.external_evidence (
  tenant_id text NOT NULL,
  id text NOT NULL,
  envelope_version text NOT NULL CHECK (envelope_version = 'ltm.external-evidence.v1'),
  issuer text NOT NULL,
  provider text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'staging', 'production')),
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 512),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  replay_policy text NOT NULL CHECK (replay_policy IN ('reusable', 'single_use')),
  algorithm text NOT NULL CHECK (algorithm = 'Ed25519'),
  key_id text NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{80,100}$'),
  status text NOT NULL CHECK (status IN ('verified', 'revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, issuer, provider, nonce),
  CHECK ((status = 'verified' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
         (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS external_evidence_scope_idx
  ON ltm.external_evidence (tenant_id, scope, status, expires_at);

CREATE TABLE IF NOT EXISTS ltm.evidence_consumptions (
  tenant_id text NOT NULL,
  evidence_id text NOT NULL,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 512),
  consumption_key_hash text NOT NULL CHECK (consumption_key_hash ~ '^[a-f0-9]{64}$'),
  consumed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, evidence_id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES ltm.external_evidence (tenant_id, id)
);

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

DROP TRIGGER IF EXISTS external_evidence_payload_immutable ON ltm.external_evidence;
CREATE TRIGGER external_evidence_payload_immutable
  BEFORE UPDATE ON ltm.external_evidence
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_external_evidence_payload_change();

DROP TRIGGER IF EXISTS external_evidence_no_delete ON ltm.external_evidence;
CREATE TRIGGER external_evidence_no_delete
  BEFORE DELETE ON ltm.external_evidence
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();

DROP TRIGGER IF EXISTS evidence_consumptions_immutable ON ltm.evidence_consumptions;
CREATE TRIGGER evidence_consumptions_immutable
  BEFORE UPDATE OR DELETE ON ltm.evidence_consumptions
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_immutable_change();

ALTER TABLE ltm.external_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.external_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE ltm.evidence_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltm.evidence_consumptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ltm.external_evidence;
CREATE POLICY tenant_isolation ON ltm.external_evidence
  USING (tenant_id = ltm.current_tenant())
  WITH CHECK (tenant_id = ltm.current_tenant());

DROP POLICY IF EXISTS tenant_isolation ON ltm.evidence_consumptions;
CREATE POLICY tenant_isolation ON ltm.evidence_consumptions
  USING (tenant_id = ltm.current_tenant())
  WITH CHECK (tenant_id = ltm.current_tenant());

COMMIT;
