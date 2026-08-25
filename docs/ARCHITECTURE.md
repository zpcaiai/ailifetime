# Implemented architecture

This repository is the executable `full-commercial` target generated from the v2.0.0 project factory. It uses the `all-typescript` stack profile and keeps commercial capabilities in a modular monolith rather than representing every reference module as a separate deployable.

## Runtime boundaries

- `packages/core` owns durable storage, tenant isolation, authorization, consent, idempotency, optimistic concurrency, inbox/outbox, append-only audit and double-entry ledger primitives.
- `packages/capabilities` owns the 22 skill domains and registers one executable, validated handler for every batch from B00 through B127.
- `packages/providers` implements native Apple/Google/WeChat verification, signed partner protocols, managed infrastructure adapters and fail-closed provider ports. Controlled transports and test authorities exist only in tests.
- `services/api` is the authenticated HTTP entrypoint for single-node and distributed deployments. It resolves actor context, limits request bodies, returns stable errors and dispatches only registered capabilities.
- `services/integration-gateway` isolates raw provider callbacks, native signature checks, replay control and immutable artifacts, then submits the signed evidence and canonical business event through one atomic application command.
- `services/workers` provides leased, retrying outbox execution with named media, notification, fulfillment, integration and data routes. Missing route adapters fail closed and keep events retryable.
- `apps/web` is the accessible consumer/operations surface. It uses public-client OIDC Authorization Code + PKCE S256, persists only a short single-use callback transaction, keeps access tokens in memory, and accepts identity only after the API's JWT/JWKS-backed `/v1/session` verification. `apps/mobile` and `apps/wechat-mini` contain secure client behavior shared by their native shells.
- `packages/sdk-ts`, `packages/sdk-python` and `packages/sdk-java` provide bounded-retry clients that send bearer authorization, purpose and idempotency context without asserting privileged identity fields.
- `infra/postgres/migrations` and `PostgresLifeTimeMachineRuntime` form the executable distributed persistence path with forced RLS. Local development uses the semantically equivalent SQLite adapter for a one-command loop.

## Trust boundaries

Tenant, actor, role, permission, guardian-verification and step-up state are server-resolved. The API rejects client attempts to assert those headers. `LTM_AUTH_MODE=local-synthetic-only` maps one fixed development bearer token to one fixed synthetic consumer and is refused in production. Distributed production requires pinned OIDC/JWKS verification. Browser authorization/token endpoints are pinned to the issuer origin and the callback is pinned to the production public origin; the SPA cannot persist tokens or request `offline_access`. Identity never substitutes for consent, price, entitlement or safety decisions.

Unknown tenant, permission, consent, workflow state, currency, provider, region or evidence state fails closed. Media output is illustrative. The code never enables biometric high-impact decisioning, and mandatory AI labeling, child protection and deletion controls are not tenant-configurable.

## Persistence

Every write is associated with an actor, tenant, purpose, request ID and idempotency key. Reusing an idempotency key with a different request fingerprint is a conflict. Domain records use optimistic versions. Audit rows and ledger entries are immutable. Ledger transactions must balance debits and credits per currency. Native callbacks pass through the isolated gateway; evidence registration/consumption, inbox deduplication, aggregate and command transition, optional ledger posting, audit and outbox all commit in one tenant transaction. Product side effects leave through a leased, bounded-retry outbox.

## External systems

Provider ports are executable boundaries, not claims of live integration. Local tests use only explicitly synthetic sandbox inputs. Production mode has no automatic fallback: a missing provider returns `EXTERNAL_ADAPTER_UNAVAILABLE`.
