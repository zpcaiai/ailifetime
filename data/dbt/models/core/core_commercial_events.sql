{{ config(unique_key=['tenant_id', 'source', 'source_sequence', 'source_primary_key'], incremental_strategy='merge') }}

select
  tenant_id,
  source,
  source_sequence,
  source_primary_key,
  source_fingerprint,
  source_occurred_at,
  ingested_at,
  source_version,
  deleted,
  currency,
  amount_minor,
  payload,
  source_occurred_at < lag(source_occurred_at) over (
    partition by tenant_id, source order by source_sequence
  ) as late_arrival
from {{ ref('stg_source_records') }}
{% if is_incremental() %}
where ingested_at > coalesce((select max(ingested_at) from {{ this }}), '1970-01-01'::timestamptz)
{% endif %}
