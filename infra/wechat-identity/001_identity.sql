CREATE SCHEMA wechat_identity;
CREATE TABLE wechat_identity.users (
 app_id text NOT NULL, subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 actor_id uuid NOT NULL, tenant_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(app_id,subject_hash), UNIQUE(app_id,actor_id)
);
CREATE TABLE wechat_identity.sessions (
 app_id text NOT NULL, session_id uuid NOT NULL, family_id uuid NOT NULL, actor_id uuid NOT NULL,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 provider_cipher text, expires_at timestamptz NOT NULL, family_expires_at timestamptz NOT NULL,
 CHECK(expires_at<=family_expires_at),
 state text NOT NULL CHECK(state IN ('active','rotated','revoked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(app_id,session_id), FOREIGN KEY(app_id,actor_id) REFERENCES wechat_identity.users(app_id,actor_id)
);
CREATE TABLE wechat_identity.requests (
 app_id text NOT NULL, operation text NOT NULL CHECK(operation IN ('create','refresh','revoke')),
 request_key text NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 code_hash text, state text NOT NULL CHECK(state IN ('executing','succeeded','failed','uncertain')),
 response_cipher text, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(app_id,operation,request_key), UNIQUE(app_id,code_hash)
);
CREATE INDEX ON wechat_identity.sessions(app_id,family_id);
CREATE INDEX ON wechat_identity.requests(app_id,created_at);
ALTER TABLE wechat_identity.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE wechat_identity.users FORCE ROW LEVEL SECURITY;
CREATE POLICY app_isolation ON wechat_identity.users USING(app_id=current_setting('ltm_identity.app_id',true)) WITH CHECK(app_id=current_setting('ltm_identity.app_id',true));
ALTER TABLE wechat_identity.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wechat_identity.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_isolation ON wechat_identity.sessions USING(app_id=current_setting('ltm_identity.app_id',true)) WITH CHECK(app_id=current_setting('ltm_identity.app_id',true));
ALTER TABLE wechat_identity.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE wechat_identity.requests FORCE ROW LEVEL SECURITY;
CREATE POLICY app_isolation ON wechat_identity.requests USING(app_id=current_setting('ltm_identity.app_id',true)) WITH CHECK(app_id=current_setting('ltm_identity.app_id',true));
