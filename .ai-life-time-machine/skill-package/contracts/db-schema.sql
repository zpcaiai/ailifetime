
-- AI Life Time Machine reference PostgreSQL schema.
-- This is a starting contract, not a drop-in production migration.
-- Every query must also enforce application authorization and purpose-specific consent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE consent_status AS ENUM ('active','expired','withdrawn','disputed','superseded');
CREATE TYPE job_state AS ENUM ('queued','preflight','running','quality_review','ready','partial','failed','cancelled','expired');
CREATE TYPE order_state AS ENUM ('awaiting_consent','paid','processing','partial','fulfilled','cancelled','refunded','disputed');
CREATE TYPE share_state AS ENUM ('active','revoked','expired','reported');
CREATE TYPE rights_case_state AS ENUM ('verification','in_progress','waiting_downstream','completed','partially_completed','denied','appealed');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('platform_b2c','partner')),
  legal_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','sandbox','pilot','production','suspended','terminated')),
  region_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_subject text,
  actor_type text NOT NULL CHECK (actor_type IN ('guest','consumer','partner_employee','platform_employee','service')),
  status text NOT NULL DEFAULT 'active',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_subject)
);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_actor_id uuid REFERENCES actors(id),
  display_alias_ciphertext bytea,
  declared_age_band text,
  minor_policy_state text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE household_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  household_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES actors(id),
  role text NOT NULL CHECK (role IN ('member','admin','guardian','temporary_collaborator')),
  status text NOT NULL CHECK (status IN ('invited','active','declined','revoked','disputed')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, household_id, actor_id)
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  grantor_actor_id uuid NOT NULL REFERENCES actors(id),
  grantor_capacity text NOT NULL CHECK (grantor_capacity IN ('self','guardian','authorized_agent','other')),
  purpose text NOT NULL,
  scope jsonb NOT NULL,
  policy_version text NOT NULL,
  status consent_status NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  granted_at timestamptz NOT NULL,
  expires_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_active_lookup ON consents(tenant_id, participant_id, purpose, status);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_actor_id uuid NOT NULL REFERENCES actors(id),
  kind text NOT NULL CHECK (kind IN ('source','normalized','intermediate','feature','result','thumbnail','export','print_ready','evidence')),
  storage_zone text NOT NULL,
  object_key_ciphertext bytea NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  encryption_key_ref text NOT NULL,
  classification text NOT NULL,
  purpose text NOT NULL,
  retention_class text NOT NULL,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_expiry ON media_assets(expires_at) WHERE deleted_at IS NULL;

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_actor_id uuid NOT NULL REFERENCES actors(id),
  household_id uuid,
  template_id text NOT NULL,
  template_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','ready','locked','archived','deleted')),
  composition jsonb NOT NULL,
  policy_version text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE project_participants (
  project_id uuid NOT NULL REFERENCES projects(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  slot_key text NOT NULL,
  consent_refs uuid[] NOT NULL,
  source_asset_refs uuid[] NOT NULL,
  PRIMARY KEY (project_id, participant_id, slot_key)
);

CREATE TABLE generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES actors(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  state job_state NOT NULL,
  request_fingerprint text NOT NULL,
  client_idempotency_key text NOT NULL,
  workflow_id text NOT NULL UNIQUE,
  quote_id uuid,
  entitlement_id uuid,
  policy_version text NOT NULL,
  provider_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_reservation_minor bigint NOT NULL DEFAULT 0,
  error_code text,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, actor_id, client_idempotency_key)
);

CREATE TABLE generation_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  job_id uuid NOT NULL REFERENCES generation_jobs(id),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id),
  participant_slot text,
  target_age integer CHECK (target_age BETWEEN 0 AND 120),
  artifact_type text NOT NULL,
  quality_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance_id text NOT NULL,
  label_manifest jsonb NOT NULL,
  publish_state text NOT NULL CHECK (publish_state IN ('held','published','revoked','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_actor_id uuid NOT NULL REFERENCES actors(id),
  token_hash text NOT NULL UNIQUE,
  state share_state NOT NULL,
  access_policy jsonb NOT NULL,
  artifact_ids uuid[] NOT NULL,
  participant_consent_refs uuid[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sku text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','active','retired')),
  entitlement_spec jsonb NOT NULL,
  fulfillment_spec jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku, version)
);

CREATE TABLE price_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid REFERENCES actors(id),
  currency char(3) NOT NULL,
  subtotal_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  discount_minor bigint NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  quote_snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES actors(id),
  partner_id uuid,
  state order_state NOT NULL,
  quote_id uuid NOT NULL REFERENCES price_quotes(id),
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  snapshot jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid REFERENCES orders(id),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  verified boolean NOT NULL,
  amount_minor bigint,
  currency char(3),
  payload_digest text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  transaction_id uuid NOT NULL,
  account_code text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  order_id uuid REFERENCES orders(id),
  settlement_id uuid,
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_entry_unique ON ledger_entries(transaction_id, account_code, direction);
-- Enforce balanced transactions in service/constraint trigger: sum(debit)=sum(credit) per currency.

CREATE TABLE partner_contract_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version integer NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  machine_policy jsonb NOT NULL,
  contract_digest text NOT NULL,
  approvals jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_key text NOT NULL,
  order_id uuid REFERENCES orders(id),
  store_ref text,
  sku text NOT NULL,
  unit text NOT NULL,
  quantity numeric(20,6) NOT NULL,
  cost_minor bigint NOT NULL DEFAULT 0,
  revenue_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL,
  contract_version integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_key)
);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency char(3) NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','reconciling','disputed','approved','locked','paid')),
  statement jsonb NOT NULL,
  statement_hash text NOT NULL,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, period_end, currency)
);

CREATE TABLE privacy_rights_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  requester_actor_id uuid NOT NULL REFERENCES actors(id),
  request_type text NOT NULL,
  state rights_case_state NOT NULL,
  scope jsonb NOT NULL,
  verification jsonb NOT NULL,
  target_at timestamptz NOT NULL,
  legal_hold_refs uuid[] NOT NULL DEFAULT '{}',
  receipt_manifest jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE deletion_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES privacy_rights_cases(id),
  system_name text NOT NULL,
  resource_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','requested','confirmed','failed','retained_legal_hold')),
  request_digest text,
  receipt_digest text,
  attempt_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, system_name, resource_ref)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid,
  actor_type text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  purpose text NOT NULL,
  decision text NOT NULL,
  reason text,
  ticket_ref text,
  before_digest text,
  after_digest text,
  trace_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_resource ON audit_events(tenant_id, resource_type, resource_id, occurred_at);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  payload jsonb NOT NULL,
  privacy jsonb NOT NULL,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON outbox_events(created_at) WHERE published_at IS NULL;

-- Reference RLS pattern. Use SET LOCAL app.tenant_id and app.actor_id only from trusted server code.
ALTER TABLE actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_actors ON actors
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Repeat an equivalent policy for every tenant table in production migrations.
