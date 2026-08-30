# Implementation status

This repository has an executable entry point for all 128 batches (`B00`
through `B127`) and binds all 640 manifest requirement IDs to those batch
entries. It deliberately uses shared transaction runtimes where trust and
persistence semantics are the same, but every batch has a unique named domain
validator and operation; the registry rejects duplicate validator reuse. A
requirement-ID binding is traceability, not independent certification: the
five acceptance statements still require their named test/evidence in a Batch
completion report. The web surface consumes a versioned server projection of
seven role portals and 22 skill workspaces. The projection contains only
capabilities allowed by both the verified role boundary and the exact
executable permission; unauthenticated production navigation fails closed.

`pnpm factory:status` reads the canonical skills, vendor manifest, and actual
TypeScript domain definitions together. It fails closed unless exactly 22
source modules expose 128 unique batch IDs, operations, and named validators,
with all 640 requirement IDs and all canonical references present. `pnpm
check` additionally executes an empty-input negative probe through all 128
handlers and requires every one to stop before persistence. Positive domain,
PostgreSQL, callback, and evidence tests remain separate from that reachability
probe.

## Exact code coverage

Every capability declares an explicit execution mode; there is no fallback/default handler:

| Mode | Batches | Behavior |
|---|---:|---|
| Resource | 68 | Tenant-scoped versioned aggregate with idempotency, audit and outbox |
| Attestation | 34 | Persist only after the required signed evidence passes |
| External command | 18 batches / 19 callback routes | Persist intent as `requested`; worker delivers it idempotently; B10 publish and revoke share one batch adapter but have distinct closed contracts |
| State transition | 4 | Enforce current/next state and optimistic version |
| Consent write | 1 | Durable participant/guardian lifecycle with exact-scope, signed server policy resolution |
| Inbox event | 1 | Deduplicated native inbound event |
| Ledger post | 1 | Balanced double-entry journal |
| Partner settlement ledger | 1 | Balanced settlement allocation |

B00 repository-baseline persistence now requires a platform administrator or
explicitly permissioned service identity; consumer `record:create` permission
cannot write it. B50 ends at `factory_attested` and rejects both the legacy
`certified` transition and caller-supplied production evidence. Five
provider-fact entries retain a closed direct endpoint, run their dedicated
side-effect-free parser for deterministic diagnostics, and persist facts only
through the compile-time signed external-event reducer.

The 36 catalog definitions marked `requiresExternalEvidence` are:

`B37,B44,B46-B49,B56,B58,B62,B66,B68-B69,B71-B72,B77,B91-B92,B94,B96-B97,B99-B100,B102,B107-B109,B118-B127`

This corrects the earlier count of 33. Five provider-fact definitions (`B66`, `B71`, `B99`, `B100`, and `B102`) reject direct capability invocation even when evidence IDs are supplied; their authoritative facts persist only through signed, atomic `external-event.apply`. The other 31 definitions are direct invocation evidence gates. Four additional external-command batches (`B74`, `B89`, `B98`, and `B101`) deliberately do not demand a result artifact before dispatch. They create a durable `requested` command, and only a later signed provider callback may apply its terminal business result. Thus 40 batches participate in an external-evidence lifecycle, while 36 carry definition-level evidence-gate metadata. The counts are not additive to the 18 external commands.

## Production integration code

- OIDC/JWKS authentication with pinned issuer, audience, token type, asymmetric algorithm allowlist, maximum token age, tenant/role/purpose claims and MFA step-up mapping
- Public SPA Authorization Code + PKCE S256 with a closed API configuration, issuer/public-origin pinning, single-use five-minute callback transactions, memory-only access tokens, refresh-token rejection, bounded CORS exchange and final `/v1/session` JWT/JWKS verification
- Apple App Store signed transaction verification through Apple's server library, certificate chain and environment/account/product binding
- Google Play product and subscription verification through server-side service-account OAuth and Android Publisher APIs
- WeChat Pay API v3 request signing, platform-certificate response/callback verification, AES-256-GCM notification decryption, merchant/order/amount binding and replay prevention
- Configuration-driven signed protocols for tax/fapiao, notification, printer/carrier, CRM/cloud and assurance partners
- AWS Secrets Manager resolution, S3/KMS/Object-Lock evidence artifacts and a Redis owner-leased `processing -> delivering/ready -> completed` callback state machine that reuses the exact signed envelope after transient delivery failure
- Deployable five-route outbox worker; production startup requires all routes and all 18 external-command batch mappings (covering 19 fixed callback routes), with least-privilege service identity
- PostgreSQL runtime for commands, queries and all B00-B127 handlers, with forced RLS, per-transaction tenant context, safe runtime-role checks and real PostgreSQL 17 CI integration
- Deployable callback gateway with two closed outputs: provider facts become a canonical business event plus exact runtime evidence in one atomic `external-event.apply`, while all 30 non-B127 direct evidence gates use fixed managed-authority routes that emit `evidence.register` for later single-use transactional consumption; B127 has no general callback route and remains release-verifier-only
- WeChat login/session and resumable media HTTP routes backed by explicit HTTPS brokers, per-request projected workload tokens, server-derived principal binding, bounded chunks/digests, dependency readiness and production startup failure when either integration is absent
- Runnable mobile HTTP application orchestration, a seven-page native WeChat mini-program, and typed session/visible-capability contracts in the TypeScript, Python and Java SDKs
- Checksum-ledgered PostgreSQL migrator with advisory locking, role/privilege/drift checks, plus immutable restricted Kubernetes release templates and a non-deploying protected release-candidate workflow
- Closed type-specific signed production-deployment and independent-approval report contracts, authority-role enrollment, and a canonical release subject derived from the checked-out pnpm lockfile, checksum-verified PostgreSQL migration manifest, B127 component set, exact API/worker/gateway/client-broker/migrator image digests, controlled provider/secret/RLS lists, public production origin, store builds, legal/a11y scope, pentest/DR artifacts, and go-live window. The required `runtime-policy-authority` report binds raw API/broker probe response digests and the three production policy digests under the deployment signature, and B127 separately retains the exact broker media-authority projection artifact. B127 verifies a production-tier Ed25519 supply-chain bundle against an independently enrolled key and requires its exact CycloneDX/SPDX document; report booleans cannot substitute for signature verification.
- Atomic evidence-gated mutations: signature/scope validation, single-use consumption, aggregate/transition/external-command/ledger write, audit and outbox commit or roll back together in both SQLite and PostgreSQL
- Closed, versioned operational-report parsers for experience, model, configuration-change, capacity and resilience gates; raw report bytes are hashed before attestation, legacy caller-authored pass/fail booleans are rejected, and production refuses sandbox evidence
- Tenant/environment/exact-scope Ed25519 evidence, trust-key validity windows, artifact hashes, nonce replay protection, revocation and single-use consumption
- Online SQLite backup to an independent file, integrity/foreign-key/audit-chain/ledger/evidence checks, content hash and actual restore drill
- Read-only B127 certifier with a PostgreSQL 17/schema-7 production source, verified TLS, minimal SELECT privileges, transaction-local tenant/partner RLS, and exact catalog inspection of the forced `tenant_isolation` policy on every schema-7 tenant and partner projection table. It verifies a live B126 prerequisite, global/100% rollout, exact profile/B00-B127/component/SBOM/handoff artifacts, a closed eleven-domain unit-bounded guardrail policy, raw query/result and pause command/receipt bytes with cross-wave uniqueness, and the closed eight-surface rollback/forward drill. The release subject and production-change approval bind all three control digests. Production change uses independently enrolled risk and operations Ed25519 approver artifacts and proves their issuer/key separation from the executor and primary signer; client booleans and arbitrary IDs are rejected. SQLite remains local/test-only and cannot certify production.

## Evidence levels

The status vocabulary is intentionally strict:

| Level | Meaning | Current result |
|---|---|---|
| `CODE_PASS` | Executable implementation and strict local tests exist | B00-B127 |
| `SANDBOX_INTEGRATION_PASS` | Native crypto/protocol paths were exercised with test authorities and controlled transports | Apple configuration guard, Google, WeChat, partner protocol, AWS/S3/Redis semantics |
| `LIVE_PROVIDER_PASS` | A named real provider account accepted/callbacked and the artifact is retained | `NOT_RUN` until credentials/endpoints are supplied |
| `INDEPENDENT_CERTIFICATION_PASS` | Named external reviewer/store/authority issued a verifiable decision | `NOT_CERTIFIED` |
| `B127 PASSED` | Production B127 record, exact release/SBOM hashes and all required independent approvals verify | `NOT_CERTIFIED` |

A passing unit, integration, browser, backup or sandbox test can never upgrade the last three rows by itself.

## Remaining external inputs

To change `NOT_CERTIFIED` to `PASSED`, the deployment owner must provide real workload identity and managed-secret references, provider/app/merchant identifiers, HTTPS callback endpoints, production evidence trust public keys, actual signed provider receipts, deployed OIDC/TLS/observability evidence, signed builds and store decisions, an independent pentest, legal/privacy approval, manual accessibility audit, disaster-recovery results, and named production change/rollout approvals. The release gate verifies those inputs; it does not manufacture them.

See [EXTERNAL_GATES.md](./EXTERNAL_GATES.md) for the exact external boundary and [../services/workers/README.md](../services/workers/README.md) for worker deployment configuration.
