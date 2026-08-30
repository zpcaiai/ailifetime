{{ config(unique_key=['tenant_id', 'subject_key', 'effective_at'], incremental_strategy='merge') }}

with versions as (
  select
    tenant_id,
    source_primary_key as subject_key,
    source_occurred_at as effective_at,
    lead(source_occurred_at) over (
      partition by tenant_id, source_primary_key order by source_occurred_at
    ) as effective_until,
    lead(source_occurred_at) over (
      partition by tenant_id, source_primary_key order by source_occurred_at
    ) is null as is_current,
    deleted,
    payload
  from {{ ref('core_commercial_events') }}
  where source in ('event', 'postgres_cdc', 'partner')
)
select * from versions
