# Implementation status

This repository implements the factory's `full-commercial` scope at the executable domain-capability level. The catalog contains 22 skill registrars and exactly one handler for every batch from B00 through B127. Each handler carries its five manifest requirement IDs, validates batch-specific invariants, authorizes a server-resolved actor, and either performs a specialized durable write or records a tenant-scoped domain intent with audit and outbox evidence.

## Implemented and locally verified

- 128 unique B00-B127 capability handlers mapped to all 640 requirement IDs
- SQLite runtime for tenant isolation, consent, minors, optimistic concurrency, fingerprinted idempotency, inbox/outbox, immutable ledger and hash-chained audit
- Server-authenticated HTTP command/query and capability dispatch with stable errors, request limits and static UI serving
- Scoped server-side external-evidence verifier boundary; absent or mismatched evidence fails closed
- Synthetic-only browser journey for B04 consent followed by B14 illustrative timeline planning
- TypeScript, Python and Java API clients that never assert actor, tenant, role or permission headers
- Mobile offline/deep-link/capture safeguards and WeChat callback/share/message safeguards
- Fail-closed provider ports plus synthetic media, payment, notification and fulfillment adapters
- Named leased outbox routes for media, notification, fulfillment, integration and data workers
- PostgreSQL forced-RLS/immutable-ledger schema contract, Docker Compose dependencies, API image and CI workflow

## Deliberate local-reference choices

The official `all-typescript` stack profile names Next.js, NestJS/Fastify, Expo, Taro, Temporal and OpenTelemetry. This implementation uses a smaller framework-light executable core so all domain functions and safety invariants can run without cloud accounts: static TypeScript web UI, Node HTTP service, client-core mobile modules, SQLite outbox scheduling and structured JSON logs. PostgreSQL is supplied as the production schema contract.

Adopting those named framework hosts is a packaging/deployment step, not evidence that their external systems work. It remains required before claiming the corresponding production surface is deployed.

## Evidence boundary

Thirty-three capabilities require verified external evidence. Their handlers cannot complete against the default runtime, even if a client submits plausible evidence IDs. B127 is therefore `NOT_CERTIFIED`.

Live AI provider quality, payment/IAP/WeChat merchant callbacks, tax and fapiao approval, app-store builds/review, printer/carrier execution, CRM/cloud connectors, regional failover, independent penetration testing, legal review, manual accessibility review and staged production rollout remain `NOT_RUN` or `NOT_CERTIFIED`. See [EXTERNAL_GATES.md](./EXTERNAL_GATES.md).
