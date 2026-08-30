# PostgreSQL production contract

`migrations/001_core.sql` is the production persistence contract for tenant records, consent, idempotency, inbox/outbox, immutable audit and balanced ledger data. `migrations/002_external_evidence.sql` adds tenant-isolated, immutable signed evidence and single-use consumption records. `migrations/003_runtime_compatibility.sql` completes the initial executable adapter contract. `migrations/004_external_business_events.sql` advances the historical runtime schema to version 4 with verified business-event digests, command lifecycle, decision linkage and immutable reducer results. `migrations/005_participant_authority_and_processing_purpose.sql` adds tenant-isolated participant, guardian and authorized-agent registries backed by signed evidence, makes record processing purpose explicit and immutable, and binds each production consent to the verified policy-catalog SHA-256 plus server jurisdiction/locale. `migrations/006_data_intelligence_durability.sql` adds durable tracking queues and warehouse watermarks. `migrations/007_commerce_partner_growth.sql` completes the schema-7 contract with durable commerce, growth, partner settlement, referral, lifecycle and partner-rate projections. Legacy rows retain null policy binding and therefore fail closed in a verified runtime.

The local default uses SQLite for a zero-service developer loop. The distributed API and worker connect through `PostgresLifeTimeMachineRuntime`, verify the migration contract and role safety at startup, and set `app.tenant_id` inside every tenant transaction. CI applies all migrations to PostgreSQL 17, provisions a non-superuser `NOBYPASSRLS` role, then exercises core and HTTP integration paths. Only an explicitly accepted single-node profile may use SQLite in production.

The migration forces row-level security. Unknown or missing tenant context returns no rows and rejects writes. Application authorization remains mandatory; RLS is the second isolation boundary.

## Production migration runner

`migrations/manifest.json` binds every ordered SQL file to an immutable SHA-256 digest. `node tools/postgres-migrate.mjs` verifies the full manifest before connecting, requires `sslmode=verify-full` in production, rejects a migrator that inherits superuser, `BYPASSRLS`, role/database creation or replication privileges, obtains a PostgreSQL advisory lock and appends each successfully committed migration to `ltm.schema_migrations`. Changed history, gaps, unknown ledger entries and an existing untracked schema fail closed.

Use a standalone dedicated role that owns the `ltm` schema (or has only the DDL grants required for it), does not own the database, has no role memberships and has no runtime data privileges outside the migration. Supply its URL through `LTM_MIGRATOR_DATABASE_URL`; the CLI never includes the URL in its report.

```bash
LTM_MIGRATOR_DATABASE_URL='postgresql://ltm_migrator@postgres.example.com/ltm?sslmode=verify-full' \
  node tools/postgres-migrate.mjs \
  --profile=production \
  --output=.artifacts/postgres-migration.json
```

The generated report proves the local runner observations and is suitable for later independent signing. It is not production certification by itself. The loopback `sslmode=disable` exception is available only with both `--profile=test` and `--allow-insecure-loopback=true`.
