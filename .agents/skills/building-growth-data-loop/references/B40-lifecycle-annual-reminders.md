---
id: B40
name: lifecycle-annual-reminders
title: "生命周期消息、年度回访与流失挽回"
version: "2.0.0"
skill: "building-growth-data-loop"
phase: "P8-growth"
status: planned
criticality: "high"
depends_on: ["B24", "B27"]
schema: "../../schemas/batch.schema.json"
---

# B40｜生命周期消息、年度回访与流失挽回

## 1. Objective

在用户选择的节奏下发送任务完成、纪念日、年度更新、订阅和家庭协作消息。

## 2. Business outcome

推动复购与留存，同时避免成瘾、羞耻和悲伤触发式营销。

## 3. Invocation contract

Use this Batch only after the dependency completion reports have passed schema and evidence validation.

**Required inputs**

```json
{
  "repo_root": "/absolute/path/to/repository",
  "batch_id": "B40",
  "baseline_report": "evidence/baseline/baseline-report.md",
  "dependency_reports": ["evidence/completion/B24.json", "evidence/completion/B27.json"],
  "allowed_paths": ["explicit paths assigned by the orchestrator"],
  "environment": "local|ci|staging",
  "constraints": ["existing stack", "regional compliance", "budget", "SLO"],
  "acceptance_commands": ["repo-native deterministic commands"]
}
```

**Required outputs**

```json
{
  "batch_id": "B40",
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

- Dependencies: **B24, B27**.
- B00 repository inventory exists and reflects the current base commit.
- The worktree is isolated, or the orchestrator has granted non-overlapping file ownership.
- Required local services and sandbox credentials are available; production secrets are not required.
- Existing project conventions, contracts, migrations, and test commands have been inspected before implementation.

## 5. Scope and target modules

- `services/lifecycle`
- `services/notification-preferences`
- `services/campaigns`
- `apps/admin/campaign-builder`

Prefer adapting existing modules discovered in B00. These paths are reference targets, not permission to create a duplicate architecture.

## 6. Interfaces and contracts

- `preference center`
- `campaign eligibility`
- `message send API`
- `suppression events`

- Update versioned contracts before or atomically with implementations.
- Preserve backward compatibility for active clients and in-flight workflows.
- Use stable error codes from `contracts/error-catalog.yaml`.
- Every write interface must define authorization, idempotency, audit, and retry semantics.

## 7. Mandatory atomic requirements

| Requirement | Statement | Gate |
|---|---|---|
| B40-R01 | 建立交易、服务、安全、家庭邀请和营销消息分类，每类渠道、频率、静默时段和退订独立。 | 必须 |
| B40-R02 | 活动受同意、成员状态、纪念敏感模式、未成年人、订阅、退订和投诉规则实时筛选。 | 必须 |
| B40-R03 | 年度提醒从用户明确日期/选择产生，不从照片、邮件或家庭事件暗中推断。 | 必须 |
| B40-R04 | 模板发布需预览变量、缺失回退、链接有效期、品牌/伙伴、语言、AI 披露和无障碍。 | 必须 |
| B40-R05 | 衡量送达、打开、行动、退订、投诉、复购和负面反馈，以净价值而非消息量优化。 | 必须 |

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

- 服务通知不得夹带隐藏营销。
- 危机、争议、删除处理中暂停非必要营销。
- 伙伴不能覆盖平台全局退订。

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
- 时区导致夜间发送
- 成员去世后仍收到成长提醒
- 变量泄露另一家庭姓名

**Mutation / anti-cheating**
- Mutation testing or targeted fault injection must demonstrate that critical assertions fail when guards are removed.
- Reject empty assertions, skipped tests, hard-coded success, mocked-away domain state, untracked fixtures, and fake evidence.

## 14. Required artifacts and evidence

Place artifacts under `evidence/B40/` and reference them from `evidence/completion/B40.json`:

- `plan.md` — inspected facts, assumptions, file-level plan, risk and rollback.
- `commands.ndjson` — command, cwd, start/end time, exit code, stdout/stderr artifact paths.
- `test-results/` — machine-readable unit/integration/contract/E2E/negative results.
- `runtime/` — screenshots or response captures where UI/API behavior matters; database/event/object-state assertions.
- `security/` — scans, authorization tests, threat/privacy updates.
- `traceability.json` — requirement → file → symbol → test → evidence → commit.
- `completion-report.json` — schema-valid final report.
- No evidence may contain real customer media or secrets.

## 15. Acceptance criteria

- All requirements `B40-R01` through `B40-R05` have complete traceability and passing evidence.
- Repo-native build, lint, type, unit, integration, contract, relevant E2E, negative, and security checks pass.
- New migrations apply from the supported previous version and a clean database; rollback/forward recovery is documented.
- No unresolved critical/high security, consent, privacy, child-safety, payment, tenant-isolation, or data-loss finding remains.
- No placeholder, stub, silent fallback, disabled gate, hard-coded success, `skip`, or fake provider result exists in production paths.
- Observability and runbook changes make failures diagnosable without exposing sensitive data.
- The Batch can be re-run from a clean checkout using documented commands and yields the same pass/fail conclusion.

## 16. Definition of Done

- Implementation, contracts, migrations, tests, fixtures, documentation, telemetry, feature flags, and rollback are committed together.
- The diff is limited to declared scope or explicitly explains shared-contract changes.
- Completion report and evidence hashes validate with `scripts/verify_release.py --batch B40`.
- A reviewer other than the implementing Agent can reproduce the key result.
- Status is `passed` only after evidence validation; otherwise use `blocked` or `failed`.
