# Implementation status

This repository has executable code for all 128 batches (`B00` through `B127`) and all 640 manifest requirements. It deliberately uses shared, configuration-driven runtimes where the trust and transaction semantics are the same; it does not pretend that every batch needs a separate large service or page. The web surface exposes seven role portals, 22 skill workspaces and the complete capability catalog.

## Exact code coverage

Every capability declares an explicit execution mode; there is no fallback/default handler:

| Mode | Batches | Behavior |
|---|---:|---|
| Resource | 68 | Tenant-scoped versioned aggregate with idempotency, audit and outbox |
| Attestation | 34 | Persist only after the required signed evidence passes |
| External command | 18 | Persist intent as `requested`; worker delivers it idempotently |
| State transition | 4 | Enforce current/next state and optimistic version |
| Consent write | 1 | Durable consent lifecycle |
| Inbox event | 1 | Deduplicated native inbound event |
| Ledger post | 1 | Balanced double-entry journal |
| Partner settlement ledger | 1 | Balanced settlement allocation |

The 36 catalog definitions marked `requiresExternalEvidence` are:

`B37,B44,B46-B49,B56,B58,B62,B66,B68-B69,B71-B72,B77,B91-B92,B94,B96-B97,B99-B100,B102,B107-B109,B118-B127`

This corrects the earlier count of 33. Five provider-fact definitions (`B66`, `B71`, `B99`, `B100`, and `B102`) reject direct capability invocation even when evidence IDs are supplied; their authoritative facts persist only through signed, atomic `external-event.apply`. The other 31 definitions are direct invocation evidence gates. Four additional external-command batches (`B74`, `B89`, `B98`, and `B101`) deliberately do not demand a result artifact before dispatch. They create a durable `requested` command, and only a later signed provider callback may apply its terminal business result. Thus 40 batches participate in an external-evidence lifecycle, while 36 carry definition-level evidence-gate metadata. The counts are not additive to the 18 external commands.

## Production integration code

- OIDC/JWKS authentication with pinned issuer, audience, token type, asymmetric algorithm allowlist, maximum token age, tenant/role/purpose claims and MFA step-up mapping
- Apple App Store signed transaction verification through Apple's server library, certificate chain and environment/account/product binding
- Google Play product and subscription verification through server-side service-account OAuth and Android Publisher APIs
- WeChat Pay API v3 request signing, platform-certificate response/callback verification, AES-256-GCM notification decryption, merchant/order/amount binding and replay prevention
- Configuration-driven signed protocols for tax/fapiao, notification, printer/carrier, CRM/cloud and assurance partners
- AWS Secrets Manager resolution, S3/KMS/Object-Lock evidence artifacts and a Redis owner-leased `processing -> delivering/ready -> completed` callback state machine that reuses the exact signed envelope after transient delivery failure
- Deployable five-route outbox worker; production startup requires all routes and all 18 external-command mappings, with least-privilege service identity
- PostgreSQL runtime for commands, queries and all B00-B127 handlers, with forced RLS, per-transaction tenant context, safe runtime-role checks and real PostgreSQL 17 CI integration
- Deployable callback gateway that converts native provider verification into a canonical business event plus exact runtime evidence and submits both through one atomic `external-event.apply` transaction using a rotating workload-identity token
- Closed, versioned operational-report parsers for experience, model, configuration-change, capacity and resilience gates; raw report bytes are hashed before attestation, legacy caller-authored pass/fail booleans are rejected, and production refuses sandbox evidence
- Tenant/environment/exact-scope Ed25519 evidence, trust-key validity windows, artifact hashes, nonce replay protection, revocation and single-use consumption
- Online SQLite backup to an independent file, integrity/foreign-key/audit-chain/ledger/evidence checks, content hash and actual restore drill
- Read-only B127 certifier with a PostgreSQL 17/schema-4 production source, verified TLS, minimal SELECT privileges, transaction-local tenant RLS, a live B126 prerequisite evidence chain, global/100% rollout enforcement, exact profile/B00-B127/component/SBOM/approval/wave/handoff artifact hashes, and a signed deployment-evidence verifier that can upgrade configuration/scanner checks only from exact, independently signed report artifacts. SQLite is deliberately local/test-only and cannot certify production.

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
