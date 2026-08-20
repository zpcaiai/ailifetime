# Implemented architecture

This repository is the executable `full-commercial` target generated from the v2.0.0 project factory. It uses the `all-typescript` stack profile and keeps commercial capabilities in a modular monolith rather than representing every reference module as a separate deployable.

## Runtime boundaries

- `packages/core` owns durable storage, tenant isolation, authorization, consent, idempotency, optimistic concurrency, inbox/outbox, append-only audit and double-entry ledger primitives.
- `packages/capabilities` owns the 22 skill domains and registers one executable, validated handler for every batch from B00 through B127.
- `packages/providers` defines AI, payment, notification and fulfillment ports. The default adapter fails closed. The sandbox adapter accepts synthetic data only and refuses to start in production.
- `services/api` is the public local entrypoint. It resolves actor context, limits request bodies, returns stable errors and dispatches only registered capabilities.
- `services/workers` provides leased, retrying outbox execution with named media, notification, fulfillment, integration and data routes. Missing route adapters fail closed and keep events retryable.
- `apps/web` is the accessible consumer/operations surface. `apps/mobile` and `apps/wechat-mini` contain secure client behavior shared by their native shells.
- `packages/sdk-ts`, `packages/sdk-python` and `packages/sdk-java` provide bounded-retry clients that send bearer authorization, purpose and idempotency context without asserting privileged identity fields.
- `infra/postgres/migrations` is the production persistence contract with forced RLS. Local development uses the semantically equivalent SQLite adapter for a one-command loop.

## Trust boundaries

Tenant, actor, role, permission, guardian-verification and step-up state are server-resolved. The API rejects client attempts to assert those headers. `LTM_AUTH_MODE=local-synthetic-only` maps one fixed development bearer token to one fixed synthetic consumer and is refused in production. A deployed environment must use server-side principals or replace the adapter with verified OIDC/OAuth claims; it must never accept consent, price, entitlement or safety decisions from a client.

Unknown tenant, permission, consent, workflow state, currency, provider, region or evidence state fails closed. Media output is illustrative. The code never enables biometric high-impact decisioning, and mandatory AI labeling, child protection and deletion controls are not tenant-configurable.

## Persistence

Every write is associated with an actor, tenant, purpose, request ID and idempotency key. Reusing an idempotency key with a different request fingerprint is a conflict. Domain records use optimistic versions. Audit rows and ledger entries are immutable. Ledger transactions must balance debits and credits per currency. External callbacks enter through a deduplicating inbox; side effects leave through a leased, bounded-retry outbox.

## External systems

Provider ports are executable boundaries, not claims of live integration. Local tests use only explicitly synthetic sandbox inputs. Production mode has no automatic fallback: a missing provider returns `EXTERNAL_ADAPTER_UNAVAILABLE`.
