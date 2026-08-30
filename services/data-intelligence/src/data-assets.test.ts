import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { INGESTION_SOURCES, SEMANTIC_METRICS } from "./index.js";

const asset = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("B112 checked-in ingestion and semantic contracts match the executable engine", async () => {
  const sources = JSON.parse(await asset("data/ingestion/sources.json")) as { sources: Array<{ id: string }> };
  const metrics = JSON.parse(await asset("data/semantic-layer/metrics.json")) as { metrics: Record<string, unknown> };
  assert.deepEqual(sources.sources.map((source) => source.id), [...INGESTION_SOURCES]);
  assert.deepEqual(Object.keys(metrics.metrics).sort(), Object.keys(SEMANTIC_METRICS).sort());
});

test("B112 dbt graph contains raw source, staging, incremental core, SCD and mart controls", async () => {
  const [project, sources, staging, core, scd, mart, schema] = await Promise.all([
    asset("data/dbt/dbt_project.yml"), asset("data/dbt/models/sources.yml"), asset("data/dbt/models/staging/stg_source_records.sql"),
    asset("data/dbt/models/core/core_commercial_events.sql"), asset("data/dbt/models/core/dim_subject_scd.sql"),
    asset("data/dbt/models/marts/mart_control_totals.sql"), asset("data/dbt/models/schema.yml"),
  ]);
  assert.match(project, /on_schema_change: fail/);
  for (const source of INGESTION_SOURCES) assert.match(sources, new RegExp(`\\b${source}\\b`));
  for (const field of ["source_sequence", "source_fingerprint", "source_occurred_at", "ingested_at", "source_version", "deleted"]) assert.match(staging, new RegExp(`\\b${field}\\b`));
  assert.match(core, /incremental_strategy='merge'/);
  assert.match(core, /late_arrival/);
  assert.match(scd, /effective_until/);
  assert.match(scd, /is_current/);
  assert.match(mart, /amount_control_minor/);
  assert.match(mart, /freshness_lag_seconds/);
  assert.match(schema, /tests: \[not_null, unique\]/);
});
