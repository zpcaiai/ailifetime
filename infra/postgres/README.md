# PostgreSQL production contract

`migrations/001_core.sql` is the production persistence contract for tenant records, consent, idempotency, inbox/outbox, immutable audit and balanced ledger data. `migrations/002_external_evidence.sql` adds tenant-isolated, immutable signed evidence and single-use consumption records. `migrations/003_runtime_compatibility.sql` completes the initial executable adapter contract. `migrations/004_external_business_events.sql` advances the runtime schema to version 4 with verified business-event digests, command lifecycle, decision linkage and immutable reducer results.

The local default uses SQLite for a zero-service developer loop. The distributed API and worker connect through `PostgresLifeTimeMachineRuntime`, verify the migration contract and role safety at startup, and set `app.tenant_id` inside every tenant transaction. CI applies all migrations to PostgreSQL 17, provisions a non-superuser `NOBYPASSRLS` role, then exercises core and HTTP integration paths. Only an explicitly accepted single-node profile may use SQLite in production.

The migration forces row-level security. Unknown or missing tenant context returns no rows and rejects writes. Application authorization remains mandatory; RLS is the second isolation boundary.
