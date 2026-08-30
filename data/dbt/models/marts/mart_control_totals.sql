select
  tenant_id,
  source,
  date_trunc('day', source_occurred_at) as metric_day,
  count(*) filter (where not deleted) as active_row_count,
  count(*) filter (where deleted) as deletion_count,
  coalesce(sum(amount_minor), 0) as amount_control_minor,
  max(ingested_at) as refreshed_at,
  extract(epoch from (current_timestamp - max(source_occurred_at)))::bigint as freshness_lag_seconds
from {{ ref('core_commercial_events') }}
group by tenant_id, source, date_trunc('day', source_occurred_at)
