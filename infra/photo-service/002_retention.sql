CREATE TABLE IF NOT EXISTS photo_service.media (
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  asset_id text NOT NULL,
  asset jsonb NOT NULL,
  object_key text NOT NULL UNIQUE,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready','deleting','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  fence uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id,actor_id,asset_id),
  CHECK (expires_at = generated_at + interval '720 hours'),
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS media_cleanup_due ON photo_service.media (next_attempt_at,expires_at) WHERE state <> 'deleted';
