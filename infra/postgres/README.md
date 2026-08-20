# PostgreSQL production contract

`migrations/001_core.sql` is the production persistence contract for tenant records, consent, idempotency, inbox/outbox, immutable audit and balanced ledger data. The local executable runtime uses SQLite for a zero-service developer loop; a production deployment must bind these same repository semantics to PostgreSQL and set `app.tenant_id` inside every transaction.

The migration forces row-level security. Unknown or missing tenant context returns no rows and rejects writes. Application authorization remains mandatory; RLS is the second isolation boundary.
