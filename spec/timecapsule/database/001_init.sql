-- Migration draft. Requires review against existing database, permissions, PII controls, retention and data residency.
CREATE TABLE IF NOT EXISTS app_user (
  id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE IF NOT EXISTS consent_record (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user(id), purpose text NOT NULL,
  policy_revision text NOT NULL, status text NOT NULL CHECK(status IN ('GRANTED','REVOKED')),
  evidence_ref text NOT NULL, granted_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS template_revision (
  template_id text NOT NULL, revision text NOT NULL, manifest jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('DRAFT','ACTIVE','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(template_id,revision)
);
CREATE TABLE IF NOT EXISTS media_asset (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user(id),
  storage_key text NOT NULL UNIQUE, sha256 char(64) NOT NULL,
  media_type text NOT NULL, state text NOT NULL CHECK(state IN ('UPLOADING','QUARANTINED','READY','DELETING','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media_asset(user_id);
CREATE TABLE IF NOT EXISTS generation_job (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user(id),
  template_id text NOT NULL, template_revision text NOT NULL, consent_id uuid NOT NULL REFERENCES consent_record(id),
  state text NOT NULL CHECK(state IN ('CREATED','VALIDATED','QUEUED','RUNNING','MODERATION','RENDERING','READY','FAILED','CANCEL_REQUESTED','CANCELLED','EXPIRED')),
  idempotency_key text NOT NULL, request_sha256 char(64) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0, provider text, result_asset_id uuid REFERENCES media_asset(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,idempotency_key), FOREIGN KEY(template_id,template_revision) REFERENCES template_revision(template_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_job_dispatch ON generation_job(state,created_at);
CREATE TABLE IF NOT EXISTS product_price (
  id text PRIMARY KEY, currency char(3) NOT NULL DEFAULT 'CNY', amount_fen bigint NOT NULL CHECK(amount_fen>=0), version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_order (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user(id),
  product_id text NOT NULL, amount_fen bigint NOT NULL CHECK(amount_fen>=0), currency char(3) NOT NULL,
  price_version integer NOT NULL, merchant_order_no text NOT NULL UNIQUE,
  state text NOT NULL CHECK(state IN ('CREATED','PENDING','PAID','FULFILLED','REFUNDING','REFUND_FAILED','REFUNDED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_event (
  provider_event_id text PRIMARY KEY, order_id uuid NOT NULL REFERENCES customer_order(id),
  verified boolean NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entitlement_grant (
  id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES customer_order(id),
  user_id uuid NOT NULL REFERENCES app_user(id), feature text NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS work (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user(id), job_id uuid UNIQUE NOT NULL REFERENCES generation_job(id),
  manifest_sha256 char(64) NOT NULL, export_asset_id uuid REFERENCES media_asset(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transactional_outbox (
  event_id uuid PRIMARY KEY, event_type text NOT NULL, aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON transactional_outbox(created_at) WHERE dispatched_at IS NULL;
CREATE TABLE IF NOT EXISTS privacy_deletion_request (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user(id), state text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, evidence_ref text
);
-- Implementation MUST use transaction boundaries, RLS or equivalent enforced service authorization,
-- explicit scoped queries, webhook verification, encrypted secrets and deletion lifecycle.
