select
  cast(tenant_id as text) as tenant_id,
  cast(source as text) as source,
  cast(source_sequence as bigint) as source_sequence,
  cast(primary_key as text) as source_primary_key,
  cast(source_fingerprint as text) as source_fingerprint,
  cast(source_occurred_at as timestamptz) as source_occurred_at,
  cast(ingested_at as timestamptz) as ingested_at,
  cast(source_version as integer) as source_version,
  coalesce(cast(deleted as boolean), false) as deleted,
  upper(cast(currency as text)) as currency,
  cast(amount_minor as bigint) as amount_minor,
  payload
from {{ source('ltm_raw', 'source_records') }}
where tenant_id is not null
  and source_sequence > 0
  and source_occurred_at <= ingested_at + interval '5 minutes'
