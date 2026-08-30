# Enterprise control plane

This service package is the dedicated B119–B124 policy and evidence runtime. It does not reuse the generic capability handler. Its three engines own configuration and regional governance, load/capacity and resilience assurance, and security/compliance evidence lifecycles.

All mutations run in an atomic SQLite command transaction with durable idempotency, optimistic aggregate versions, append-only events, tenant-qualified keys, and permanent signed-fact replay protection. External facts use a closed Ed25519 envelope and exact authority/environment/tenant/fact-kind/subject bindings; wildcards and self-issued independent evidence are rejected.

## Runtime boundary

- `EnterpriseGovernanceEngine`: B119–B120.
- `EnterpriseAssuranceEngine`: B121–B122.
- `EnterpriseSecurityComplianceEngine`: B123–B124.
- `SqliteEnterpriseRepository`: checksum-bound schema, event stream, idempotency ledger, and semantic fact uniqueness.
- `ENTERPRISE_REQUIREMENT_TRACE`: the exact 30 mandatory requirements and their executable verification points.

Production configuration must use an absolute durable database path, workload identity, and a `secret-manager://` authority catalog reference. The catalog contains public verification keys only; private keys and provider credentials are never accepted by this package. The protected consent, safety, AI-label, children, high-impact, and provenance controls are literal `true` constants and cannot be configured off.

## Certification semantics

Design records begin as `NOT_CERTIFIED`. A test or staging attestation may produce only `TEST_VERIFIED`. `CERTIFIED` is reachable only from a production-scoped, independently authorized Ed25519 fact that exactly matches the previously approved subject and policy inputs. This code cannot establish that a real external engagement occurred.

Consequently, real independent penetration testing, production game-day execution, legal/regulatory filing, and multi-region runtime operation remain `NOT_CERTIFIED` until their named external authorities deliver production evidence. Unit tests use generated test-only keys and never count as those external outcomes.

Run:

```sh
pnpm --filter @ltm/enterprise-control-plane typecheck
pnpm --filter @ltm/enterprise-control-plane test
```
