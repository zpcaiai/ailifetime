---
id: B18
name: cost-latency-cache
title: "成本、延迟、配额与安全缓存"
version: "2.0.0"
skill: "building-age-media-pipeline"
phase: "P3-media"
status: planned
criticality: "high"
depends_on: ["B12", "B13", "B14", "B15", "B16"]
schema: "../../schemas/batch.schema.json"
---

# B18｜成本、延迟、配额与安全缓存

## 1. Objective

在保证质量和隐私的前提下控制每次生成成本、等待时间与供应商容量。

## 2. Business outcome

形成可盈利的 SKU、可承诺的伙伴 SLA 和突发流量韧性。

## 3. Invocation contract

Use this Batch only after the dependency completion reports have passed schema and evidence validation.

**Required inputs**

```json
{
  "repo_root": "/absolute/path/to/repository",
  "batch_id": "B18",
  "baseline_report": "evidence/baseline/baseline-report.md",
  "dependency_reports": ["evidence/completion/B12.json", "evidence/completion/B13.json", "evidence/completion/B14.json", "evidence/completion/B15.json", "evidence/completion/B16.json"],
  "allowed_paths": ["explicit paths assigned by the orchestrator"],
  "environment": "local|ci|staging",
  "constraints": ["existing stack", "regional compliance", "budget", "SLO"],
  "acceptance_commands": ["repo-native deterministic commands"]
}
```

**Required outputs**

```json
{
  "batch_id": "B18",
  "status": "passed|blocked|failed",
  "changed_files": [],
  "entrypoints": [],
  "tests": [],
  "evidence": [],
  "migrations": [],
  "risks": [],
  "follow_ups": [],
  "commit": null
}
```

The completion report must validate against `<repo>/.ai-life-time-machine/skill-package/schemas/completion-report.schema.json`.

## 4. Preconditions

- Dependencies: **B12, B13, B14, B15, B16**.
- B00 repository inventory exists and reflects the current base commit.
- The worktree is isolated, or the orchestrator has granted non-overlapping file ownership.
- Required local services and sandbox credentials are available; production secrets are not required.
- Existing project conventions, contracts, migrations, and test commands have been inspected before implementation.

## 5. Scope and target modules

- `services/cost-engine`
- `services/quota`
- `services/cache`
- `apps/admin/cost-console`

Prefer adapting existing modules discovered in B00. These paths are reference targets, not permission to create a duplicate architecture.

## 6. Interfaces and contracts

- `cost estimate API`
- `quota reservation`
- `provider budget policy`
- `usage ledger`

- Update versioned contracts before or atomically with implementations.
- Preserve backward compatibility for active clients and in-flight workflows.
- Use stable error codes from `contracts/error-catalog.yaml`.
- Every write interface must define authorization, idempotency, audit, and retry semantics.

## 7. Mandatory atomic requirements

| Requirement | Statement | Gate |
|---|---|---|
| B18-R01 | 生成前根据节点数、分辨率、视频时长、供应商、重试预算和渠道分成计算可解释成本预估并预留额度。 | 必须 |
| B18-R02 | 建立租户/用户/活动/供应商/模型多级配额、并发、速率与日预算，超限提供排队或降级而非失控调用。 | 必须 |
| B18-R03 | 缓存只复用同一授权主体和完全相同策略下的安全中间产物；禁止跨用户人脸结果缓存命中。 | 必须 |
| B18-R04 | 收集每步骤实际 token/图片/视频/存储/带宽/人工审核成本，与订单收入和退款关联。 | 必须 |
| B18-R05 | 按 P50/P95/P99 延迟和成本回归自动调路由，任何降级不得突破质量、安全、地域或同意约束。 | 必须 |

No requirement may be marked complete using prose alone. Each requires source, symbol/entrypoint, test, and evidence references.

## 8. Implementation workflow

1. **Inspect** — read the relevant existing code, contracts, migrations, tests, logs, and dependency completion reports.
2. **Plan** — produce a file-level plan, list contract changes, migration strategy, feature flags, risks, and exact acceptance commands.
3. **Contract first** — add or update schemas, API/event contracts, permission decisions, error codes, and fixtures.
4. **Implement vertically** — complete the smallest end-to-end slice through UI/API/domain/worker/storage as applicable.
5. **Secure by construction** — enforce tenant, participant consent, data purpose, retention, AI-label, and audit controls in code.
6. **Test** — run unit, integration, contract, E2E, negative, mutation/anti-cheating, migration, and regression tests relevant to this Batch.
7. **Observe** — add structured events, traces, metrics, SLO indicators, and business metrics without sensitive payloads.
8. **Verify** — run the Batch gate from a clean process; inspect the actual output, database state, emitted events, object manifests, and UI.
9. **Evidence** — write a schema-valid completion report and evidence index with hashes and command exit codes.
10. **Handoff** — leave the worktree reviewable; do not merge, deploy, or mark passed when a blocking check is unresolved.

## 9. Deterministic constraints

- 免费预览必须有硬预算和反滥用。
- 成本预估与最终结算单位必须一致。
- 缓存键不得包含明文敏感信息。

Global invariants:

- Age outputs are **illustrative AI transformations**, never forecasts of actual appearance, health, longevity, occupation, wealth, or life outcome.
- Every identifiable participant requires purpose-specific, revocable authorization.
- No facial output or interaction signal may influence insurance underwriting, pricing, claim, credit, employment, medical, or eligibility decisions.
- AI generation labels and provenance controls are non-optional.
- Unknown authorization, policy, state, or contract versions fail closed.
- All external side effects are idempotent, auditable, retry-bounded, and compensatable where feasible.

## 10. Authorization and permissions

- Resolve the authenticated actor, tenant, role, resource owner/participant, purpose, and current consent at the server.
- Never trust client-supplied role, tenant, price, ownership, consent, quality, or safety assertions.
- Use least-privilege service credentials and time-limited signed media access.
- Sensitive admin operations require reason, ticket/case, audit event, and step-up/two-person control when specified.
- The coding Agent may write only assigned paths and may not access production accounts, real customer media, or irreversible infrastructure.

## 11. Failure, retry, cancellation, and idempotency

- Classify errors as validation, authorization, consent, policy, transient dependency, permanent dependency, conflict, quota, or internal.
- Define idempotency keys for every externally visible write and persist request fingerprints.
- Use bounded exponential backoff with jitter; do not retry authorization, policy, malformed input, or deterministic failures.
- Preserve partial evidence and resumable state after failure.
- Retry at most three implementation/verification loops before marking the Batch `blocked` with root cause and recovery plan.
- A cancellation or rollback must not resurrect revoked consent, deleted media, refunded entitlements, or expired sharing.

## 12. Data, privacy, and security

- Apply data minimization, classification, encryption in transit/at rest, retention, deletion propagation, and audit.
- Keep raw media, derived media, embeddings/features, business data, and logs in separately governed stores.
- Never log original images, complete prompts containing sensitive data, payment credentials, or future-self private conversations.
- Add abuse-rate controls and content/identity safeguards where the surface is externally reachable.
- Update the data map, threat model, privacy impact assessment, and subprocessor record when the data flow changes.

## 13. Test plan

**Unit**
- Domain invariants, state transitions, policy decisions, serialization, money/time handling, and error mapping.
- Every branch introduced by the five mandatory requirements.

**Integration**
- Database constraints/migrations, object storage, queue/workflow, provider/payment/partner adapters, and authorization.
- Duplicate, delayed, reordered, cancelled, and partially failed operations.

**Contract**
- OpenAPI/JSON Schema/event compatibility, consumer-driven contracts, webhook signatures, and SDK fixtures.

**End-to-end**
- At least one realistic happy path and one recoverable failure path through actual public entrypoints.

**Negative and abuse**
- 供应商计价突然变化
- 缓存误跨租户
- 配额预留后任务取消

**Mutation / anti-cheating**
- Mutation testing or targeted fault injection must demonstrate that critical assertions fail when guards are removed.
- Reject empty assertions, skipped tests, hard-coded success, mocked-away domain state, untracked fixtures, and fake evidence.

## 14. Required artifacts and evidence

Place artifacts under `evidence/B18/` and reference them from `evidence/completion/B18.json`:

- `plan.md` — inspected facts, assumptions, file-level plan, risk and rollback.
- `commands.ndjson` — command, cwd, start/end time, exit code, stdout/stderr artifact paths.
- `test-results/` — machine-readable unit/integration/contract/E2E/negative results.
- `runtime/` — screenshots or response captures where UI/API behavior matters; database/event/object-state assertions.
- `security/` — scans, authorization tests, threat/privacy updates.
- `traceability.json` — requirement → file → symbol → test → evidence → commit.
- `completion-report.json` — schema-valid final report.
- No evidence may contain real customer media or secrets.

## 15. Acceptance criteria

- All requirements `B18-R01` through `B18-R05` have complete traceability and passing evidence.
- Repo-native build, lint, type, unit, integration, contract, relevant E2E, negative, and security checks pass.
- New migrations apply from the supported previous version and a clean database; rollback/forward recovery is documented.
- No unresolved critical/high security, consent, privacy, child-safety, payment, tenant-isolation, or data-loss finding remains.
- No placeholder, stub, silent fallback, disabled gate, hard-coded success, `skip`, or fake provider result exists in production paths.
- Observability and runbook changes make failures diagnosable without exposing sensitive data.
- The Batch can be re-run from a clean checkout using documented commands and yields the same pass/fail conclusion.

## 16. Definition of Done

- Implementation, contracts, migrations, tests, fixtures, documentation, telemetry, feature flags, and rollback are committed together.
- The diff is limited to declared scope or explicitly explains shared-contract changes.
- Completion report and evidence hashes validate with `scripts/verify_release.py --batch B18`.
- A reviewer other than the implementing Agent can reproduce the key result.
- Status is `passed` only after evidence validation; otherwise use `blocked` or `failed`.
