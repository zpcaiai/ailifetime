---
id: B45
name: observability-slo-cost
title: "可观测性、SLO、容量与成本运营"
version: "2.0.0"
skill: "securing-operating-life-time-machine"
phase: "P9-trust-ops"
status: planned
criticality: "high"
depends_on: ["B09", "B13", "B18", "B44"]
schema: "../../schemas/batch.schema.json"
---

# B45｜可观测性、SLO、容量与成本运营

## 1. Objective

让用户旅程、工作流、供应商、支付、履约和伙伴 API 的健康与成本可见。

## 2. Business outcome

在故障影响扩大前发现问题，并能按业务承诺和毛利做容量决策。

## 3. Invocation contract

Use this Batch only after the dependency completion reports have passed schema and evidence validation.

**Required inputs**

```json
{
  "repo_root": "/absolute/path/to/repository",
  "batch_id": "B45",
  "baseline_report": "evidence/baseline/baseline-report.md",
  "dependency_reports": ["evidence/completion/B09.json", "evidence/completion/B13.json", "evidence/completion/B18.json", "evidence/completion/B44.json"],
  "allowed_paths": ["explicit paths assigned by the orchestrator"],
  "environment": "local|ci|staging",
  "constraints": ["existing stack", "regional compliance", "budget", "SLO"],
  "acceptance_commands": ["repo-native deterministic commands"]
}
```

**Required outputs**

```json
{
  "batch_id": "B45",
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

- Dependencies: **B09, B13, B18, B44**.
- B00 repository inventory exists and reflects the current base commit.
- The worktree is isolated, or the orchestrator has granted non-overlapping file ownership.
- Required local services and sandbox credentials are available; production secrets are not required.
- Existing project conventions, contracts, migrations, and test commands have been inspected before implementation.

## 5. Scope and target modules

- `observability/otel`
- `services/slo`
- `apps/admin/operations`
- `services/cost-alerting`

Prefer adapting existing modules discovered in B00. These paths are reference targets, not permission to create a duplicate architecture.

## 6. Interfaces and contracts

- `OpenTelemetry traces/metrics/logs`
- `SLO definitions`
- `alert routes`
- `runbooks`

- Update versioned contracts before or atomically with implementations.
- Preserve backward compatibility for active clients and in-flight workflows.
- Use stable error codes from `contracts/error-catalog.yaml`.
- Every write interface must define authorization, idempotency, audit, and retry semantics.

## 7. Mandatory atomic requirements

| Requirement | Statement | Gate |
|---|---|---|
| B45-R01 | 统一 trace_id、workflow_id、job_id、order_id、tenant_id 和 provider_call_id，但日志不得含原图或敏感正文。 | 必须 |
| B45-R02 | 定义上传、生成、支付、下载、伙伴 API、删除、打印和对话的 SLI/SLO、错误预算和用户影响分级。 | 必须 |
| B45-R03 | 仪表盘同时展示可用性、延迟、质量失败、供应商错误、队列积压、退款、成本/生成和结算异常。 | 必须 |
| B45-R04 | 告警按可行动性、去重、抑制、升级和 on-call 归属设计；每个高优告警链接运行手册和最近变更。 | 必须 |
| B45-R05 | 容量模型覆盖活动峰值、视频 GPU/供应商配额、对象存储、数据库、队列和伙伴批量订单，提供降级计划。 | 必须 |

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

- 不得为了可观测性记录完整提示、对话、照片或支付数据。
- SLO 报表按伙伴合同边界隔离。
- 降级不能关闭安全审核、同意或 AI 标识。

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
- 遥测后端故障
- 高基数标签爆炸
- 供应商延迟正常但质量骤降

**Mutation / anti-cheating**
- Mutation testing or targeted fault injection must demonstrate that critical assertions fail when guards are removed.
- Reject empty assertions, skipped tests, hard-coded success, mocked-away domain state, untracked fixtures, and fake evidence.

## 14. Required artifacts and evidence

Place artifacts under `evidence/B45/` and reference them from `evidence/completion/B45.json`:

- `plan.md` — inspected facts, assumptions, file-level plan, risk and rollback.
- `commands.ndjson` — command, cwd, start/end time, exit code, stdout/stderr artifact paths.
- `test-results/` — machine-readable unit/integration/contract/E2E/negative results.
- `runtime/` — screenshots or response captures where UI/API behavior matters; database/event/object-state assertions.
- `security/` — scans, authorization tests, threat/privacy updates.
- `traceability.json` — requirement → file → symbol → test → evidence → commit.
- `completion-report.json` — schema-valid final report.
- No evidence may contain real customer media or secrets.

## 15. Acceptance criteria

- All requirements `B45-R01` through `B45-R05` have complete traceability and passing evidence.
- Repo-native build, lint, type, unit, integration, contract, relevant E2E, negative, and security checks pass.
- New migrations apply from the supported previous version and a clean database; rollback/forward recovery is documented.
- No unresolved critical/high security, consent, privacy, child-safety, payment, tenant-isolation, or data-loss finding remains.
- No placeholder, stub, silent fallback, disabled gate, hard-coded success, `skip`, or fake provider result exists in production paths.
- Observability and runbook changes make failures diagnosable without exposing sensitive data.
- The Batch can be re-run from a clean checkout using documented commands and yields the same pass/fail conclusion.

## 16. Definition of Done

- Implementation, contracts, migrations, tests, fixtures, documentation, telemetry, feature flags, and rollback are committed together.
- The diff is limited to declared scope or explicitly explains shared-contract changes.
- Completion report and evidence hashes validate with `scripts/verify_release.py --batch B45`.
- A reviewer other than the implementing Agent can reproduce the key result.
- Status is `passed` only after evidence validation; otherwise use `blocked` or `failed`.
