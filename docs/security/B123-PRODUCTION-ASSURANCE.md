# B123 production security assurance

## Current truth

The repository now has production code paths for B123-R01, R02, R03, and R05. B123-R04 is deliberately `BLOCKED_EXTERNAL`: no independent penetration-test provider or signed production report is enrolled in `security/pentest/trusted-providers.json`. The gate can reach `PASS` only after real third-party evidence is supplied; a local fixture, an employee assertion, or a self-signed report cannot do so.

These states are separate:

- `PASS`: every required scanner report was actually supplied, parsed, and contains no critical/high finding.
- `FAIL`: a required control ran and found a blocking defect or invalid/tampered evidence.
- `NOT_RUN`: CodeQL, SCA, Trivy image/config, secret scan, or DAST evidence is absent. Exit code is 2.
- `BLOCKED_EXTERNAL`: the independent assessor, production registry digest, or other external authority evidence is absent.

## B123-R01 — reproducible signed supply chain

`tools/security-sbom.mjs` creates deterministic CycloneDX 1.6, SPDX 2.3, dependency-license, file-digest, in-toto/SLSA provenance, and Ed25519 attestation documents. The detached attestation signs the hashes of every document and the canonical artifact manifest; verification recalculates all document hashes before checking the signature. It refuses unsigned output.

CI uses a run-scoped Ed25519 key for the CI trust tier, then attaches GitHub OIDC build provenance to the signed bundle on `main`. A production release must instead use an externally managed Ed25519 key whose key ID is on the production trust list. A CI-scoped key is not production release authority.

OCI artifacts are captured by `tools/security-image-manifest.mjs`. Local/CI image IDs prove the exact built content but do not pretend to be pushed-registry digests. Production verification requires all five application workloads (`api`, `workers`, `integration-gateway`, `client-integration-broker`, `migrator`) to carry `registry/name@sha256:...` digests. PostgreSQL, Redis and object storage are managed dependencies verified by their dedicated signed deployment reports, not substituted with unrelated container-image assertions. Missing workload registry digests produce `BLOCKED_EXTERNAL`.

The service Dockerfiles pin Node.js 26.0.0 Bookworm Slim to the registry-resolved multi-architecture OCI index digest as well as its human-readable tag. Deployment must still resolve the five application images to their own immutable registry digests, run Trivy against those exact images, and bind the resulting manifest into the signed supply-chain bundle.

Reproduce after building:

```sh
openssl genpkey -algorithm ED25519 -out /tmp/ltm-ci-key.pem
node tools/security-sbom.mjs generate --private-key=/tmp/ltm-ci-key.pem --environment=ci --trust-tier=ci --source-date-epoch=0 --out=.artifacts/security/supply-chain
node tools/security-sbom.mjs verify --bundle=.artifacts/security/supply-chain/bundle.json
```

## B123-R02 — complete CI scan evidence

The `b123-security-assurance` job runs and retains evidence for:

| Surface | Engine/evidence | Blocking rule |
| --- | --- | --- |
| Secrets | repository secret scanner | any finding |
| SAST | CodeQL `security-extended` SARIF | error or security severity >= 7 |
| SCA | `pnpm audit --prod --json` | high/critical |
| IaC | Trivy config JSON plus native invariants | high/critical |
| Containers | five Trivy scans over the exact locally built OCI IDs (API, worker, gateway, client broker, migrator) | high/critical |
| API | OpenAPI/server invariants plus live DAST | missing control or failed probe |
| Frontend | targeted browser-storage, DOM injection, TLS checks | high/critical |
| Mobile | targeted storage, transport, credential checks | high/critical |
| WeChat mini program | targeted storage, transport, credential checks | high/critical |

The native regular-expression checks are described as `native-guardrails`; they never substitute for CodeQL, Trivy, or DAST. The unified gate refuses to report `PASS` if any required external engine report is missing. Third-party GitHub Actions are pinned to immutable commit SHAs, with their human-readable versions left as comments.

## B123-R03 — executable DAST and negative regressions

`tools/security-dast.mjs` makes real HTTP calls and checks outcomes, response bodies, redirect behavior, and security headers. It covers:

- missing/invalid authentication and spoofed server-resolved tenant/role headers;
- a cross-tenant direct-object-reference attempt with a secret synthetic marker;
- upload rejection when EXIF removal is false and fail-closed absence of a signed-URL route;
- webhook signature constraints and payment rejection of raw credentials/amount mismatch;
- loopback, localhost, and cloud-metadata SSRF targets;
- reflected XSS, strict production CSP, HSTS, CSRF without ambient cookies/CORS, and admin authorization.

The runner accepts clear-text HTTP only on loopback. A staging/production origin requires a time-limited exact-target authorization document. `--profile=ci` and `--profile=production` additionally require HSTS for at least one year with subdomains and prohibit CSP `unsafe-inline`/`unsafe-eval`.

## B123-R04 — independent test evidence

`tools/security-pentest-evidence.mjs` validates an Ed25519-signed report from an enrolled independent organization. Signed scope must include authentication, tenant isolation, IDOR, upload, signed URLs, webhook, payment, SSRF, XSS, CSRF, and admin operations. It also binds test windows, named assessors, target origin, synthetic-data handling, responsibilities, report artifact digest, finding registry digest, unresolved counts, and independent retest.

Run the current production gate:

```sh
node tools/security-pentest-evidence.mjs --allow-blocked=true
```

The expected current result is `BLOCKED_EXTERNAL`. Onboarding a provider key is a reviewed security-governance change, not a developer shortcut.

## B123-R05 — finding lifecycle

`security/findings.mjs` implements the legal state machine `new -> triaged -> remediation_in_progress -> ready_for_retest -> closed`, plus controlled false-positive and risk-acceptance paths. It enforces severity SLA, named owner, hash-chained events, independent retest, disclosure assessment, exception approval separation, expiration, compensating controls, and maximum exception durations. An expired exception fails validation; a high/critical open finding blocks the registry gate.

### Required B119/B121/B122 production dependencies

The B123/B127 production decision also consumes the operational controls that precede it. `tools/security-upstream-evidence.mjs` does not accept a caller's `driftCheckPassed`, `paidTasksProtected`, `tenantFairnessVerified`, `cancellationPriorityVerified`, `deletionResurrectionPrevented`, or `duplicateSideEffectsPrevented` flag. It requires all three original JSON report artifacts and verifies their closed v1 schemas, raw-byte SHA-256 digests, exact capability scopes, Ed25519 signatures, issuer/provider trust, validity periods, production environment, and subjects:

| Batch | Operation | Signed report kind | Provider authority | Subject/digest |
| --- | --- | --- | --- | --- |
| B119 | `approveConfigurationChange` | `configuration-change-report` | `change-control:${changeControlProviderId}` | `changeId` / `changeReportSha256` |
| B121 | `approveCapacityGate` | `capacity-test-report` | `load-test:${loadTestProviderId}` | `testRunId` / `capacityReportSha256` |
| B122 | `recordResilienceExercise` | `resilience-exercise-report` | `resilience-auditor:${resilienceProviderId}` | `exerciseId` / `resilienceReportSha256` |

The checked-in trust store is deny-all. This diagnostic command therefore truthfully returns `BLOCKED_EXTERNAL`; without `--allow-blocked=true` it exits 2:

```sh
node tools/security-upstream-evidence.mjs --allow-blocked=true
```

A real production invocation supplies `--bundle`, `--trust-store`, and optionally `--artifact-root`. Artifact paths are constrained beneath that root, including symlink resolution. Unknown issuer keys remain `BLOCKED_EXTERNAL`; malformed, tampered, expired, incorrectly scoped, or failing reports exit 1.

Run anti-cheating tests:

```sh
pnpm run test:security
```

## Rollback and incident handling

The CI job is additive and can be disabled only through a reviewed workflow revert. Do not add blanket scanner ignores. A false positive must enter the finding lifecycle with an independent approval. A suspected leaked key must be revoked and rotated immediately; deleting a Git line is insufficient. Evidence artifacts contain synthetic identifiers and digests only, never customer media, bearer tokens, payment credentials, or assessor confidential report bodies.
