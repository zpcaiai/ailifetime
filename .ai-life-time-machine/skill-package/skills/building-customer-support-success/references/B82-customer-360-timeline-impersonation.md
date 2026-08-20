---
id: B82
name: customer-360-timeline-impersonation
title: "客户 360、时间线与受控代操作"
version: "2.0.0"
skill: "building-customer-support-success"
phase: "P15-support-success"
status: planned
criticality: "high"
depends_on: ["B03", "B04", "B11", "B30", "B43"]
schema: "../../schemas/batch.schema.json"
---

# B82｜客户 360、时间线与受控代操作

## 1. Objective

为客服和运营提供最小必要的客户、家庭、订单、工单和授权时间线。

## 2. Business outcome

加快排障和服务恢复，同时防止内部人员浏览敏感媒体或无痕代操作。

## 3. Invocation contract

Use this Batch only when it is included by the active project profile and every dependency completion report has passed schema and evidence validation.

**Required inputs**

```json
{
  "repo_root": "/absolute/path/to/repository",
  "batch_id": "B82",
  "project_profile": ".ai-life-time-machine/project-profile.json",
  "baseline_report": "evidence/baseline/baseline-report.md",
  "dependency_reports": ["evidence/completion/B03.json", "evidence/completion/B04.json", "evidence/completion/B11.json", "evidence/completion/B30.json", "evidence/completion/B43.json"],
  "allowed_paths": ["explicit paths assigned by the orchestrator"],
  "environment": "local|ci|staging",
  "constraints": ["existing stack", "regional compliance", "budget", "SLO"],
  "acceptance_commands": ["repo-native deterministic commands"]
}
```

**Required outputs**

```json
{
  "batch_id": "B82",
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

- Dependencies: **B03, B04, B11, B30, B43**.
- B00 repository inventory exists and reflects the current base commit.
- The active profile and stack profile have passed validation and still match completed evidence.
- The worktree is isolated, or the orchestrator has granted non-overlapping file ownership.
- Required local services and sandbox credentials are available; production secrets are not required.
- Existing conventions, contracts, migrations, tests, feature flags, and runtime behavior have been inspected first.

## 5. Scope and target modules

- `services/customer-360`
- `apps/support-console/customer`
- `packages/impersonation-control`

These paths are reference targets. Adapt existing modules discovered in B00 rather than creating a parallel architecture.

## 6. Interfaces and contracts

- `customer summary API`
- `timeline event`
- `field masking`
- `support session`

- Update versioned contracts before or atomically with implementations.
- Preserve compatibility for active clients, mobile versions, partner integrations, and in-flight workflows.
- Use stable error codes from `contracts/error-catalog.yaml`.
- Every write defines authorization, purpose, idempotency, audit, retry, cancellation, reconciliation, and deletion semantics.

## 7. Mandatory atomic requirements

| Requirement | Statement | Gate |
|---|---|---|
| B82-R01 | 聚合账户、家庭角色、项目状态、订单、权益、通知、工单、同意和数据权利请求的服务摘要。 | 必须 |
| B82-R02 | 原始媒体、特征、对话和支付凭据默认不展示；需要时按理由、工单、范围和时间临时授权。 | 必须 |
| B82-R03 | 代操作使用单独 support session、明显 UI 标识、禁止查看秘密、不可提升权限，并记录每次读写。 | 必须 |
| B82-R04 | 敏感字段按角色、地区、租户和工单类型脱敏，导出/复制/截图等行为受限制与审计。 | 必须 |
| B82-R05 | 时间线事件使用稳定来源和关联 ID，可区分业务事实、第三方回调、客服动作和模型结果。 | 必须 |

No requirement may be marked complete using prose alone. Each requires source file, symbol/entrypoint, test, runtime evidence, and commit references.

## 8. Implementation workflow

1. **Inspect** — read existing code, contracts, migrations, tests, production-safe logs, profile, and dependency reports.
2. **Plan** — produce a file-level plan, contract changes, migration strategy, flags, permissions, risks, rollback, and exact acceptance commands.
3. **Contract first** — update API/event/data/UI contracts, permission decisions, error codes, fixtures, and compatibility tests.
4. **Implement vertically** — complete the smallest end-to-end slice through every affected client, API, domain, worker, store, and external adapter.
5. **Secure by construction** — enforce tenant, actor, participant consent, purpose, retention, AI-label, finance, and audit controls in code.
6. **Test** — run all relevant unit, integration, contract, E2E, negative, mutation/fault, migration, accessibility, performance, and regression checks.
7. **Observe** — add structured events, traces, metrics, SLO indicators, business controls, and runbooks without sensitive payloads.
8. **Verify** — execute the Batch gate from a clean process; inspect actual UI/API/database/event/object/ledger/provider state.
9. **Evidence** — write schema-valid completion and traceability records with hashes and command exit codes.
10. **Handoff** — leave the worktree reviewable; do not merge, deploy, or claim pass with an unresolved blocking check.

## 9. Functional design obligations

- Model domain states explicitly; avoid boolean combinations that permit impossible commercial states.
- Keep UI projections separate from server-side authorization and commercial truth.
- Define compatibility behavior for old links, clients, SDKs, jobs, orders, and partner payloads.
- Support deterministic local/sandbox fixtures for every external provider.
- Include operator recovery for recoverable failures and fail closed for unknown consent, money, ownership, or policy state.

## 10. Deterministic constraints

- 不得按好奇心访问名人或同事账户。
- 代操作不能接受同意或签署授权。
- 删除后的内容不在聚合缓存复现。

Global invariants:

- Age outputs are **illustrative AI transformations**, never forecasts of actual appearance, health, longevity, occupation, wealth, or life outcome.
- Every identifiable participant requires purpose-specific, revocable authorization.
- No facial output or interaction signal may influence insurance underwriting, pricing, claims, credit, employment, medical, or eligibility decisions.
- AI generation labels and provenance controls are non-optional and cannot be removed by payment or white label.
- Unknown authorization, policy, money, tenant, or contract versions fail closed.
- All external side effects are idempotent, auditable, retry-bounded, and compensatable where feasible.
- Financial facts reconcile to immutable ledgers; analytics never substitutes for accounting truth.

## 11. Authorization and permissions

- Resolve actor, tenant, role, resource owner/participant, purpose, consent, commercial entitlement, and policy version at the server.
- Never trust client-supplied role, tenant, ownership, price, consent, quality, safety, tax, refund, or approval assertions.
- Use least-privilege, short-lived credentials and time-limited signed media access.
- Sensitive admin/support/finance operations require reason, case/ticket, audit event, step-up, and two-person control where specified.
- The coding Agent may write only assigned paths and may not access production accounts, real customer media, or irreversible infrastructure.

## 12. Failure, retry, cancellation, reconciliation, and idempotency

- Classify errors as validation, authorization, consent, policy, conflict, quota, transient dependency, permanent dependency, reconciliation, or internal.
- Define idempotency keys and request fingerprints for every externally visible write.
- Use bounded exponential backoff with jitter; never retry deterministic policy, malformed input, or authorization failures.
- Preserve partial evidence and resumable state after failure; use dead-letter/replay controls where asynchronous.
- Retry at most three implementation/verification loops before marking `blocked` with root cause and recovery plan.
- Cancellation, rollback, retry, or replay must not resurrect revoked consent, deleted media, refunded entitlements, expired shares, or cancelled vendor work.

## 13. Data, privacy, security, and compliance

- Apply minimization, classification, encryption, purpose binding, retention, deletion propagation, audit, and regional processing controls.
- Separate raw media, derived assets, biometric-like features, business data, financial truth, analytics, and logs into governed stores.
- Never log original media, full prompts containing sensitive data, payment credentials, identity documents, or private future-self conversations.
- Add abuse/rate controls and content/identity safeguards to every public or partner-reachable surface.
- Update the data map, threat model, privacy impact assessment, subprocessor/vendor record, and compliance evidence when data flows change.
- Use professional legal, tax, security, accessibility, and regulatory review before production where applicable.

## 14. Test plan

**Unit**
- Domain invariants, state transitions, permissions, serialization, money/time/locale handling, and error mapping.
- Every branch introduced by all five mandatory requirements.

**Integration**
- Database constraints/migrations, object storage, queue/workflow, provider/payment/partner/vendor adapters, authorization, and reconciliation.
- Duplicate, delayed, reordered, cancelled, partially failed, expired, and replayed operations.

**Contract**
- OpenAPI/JSON Schema/event/SDK/mobile compatibility, consumer-driven contracts, webhook signatures, and fixture conformance.

**End-to-end**
- At least one realistic happy path, one recoverable failure, and one fail-closed path through actual public/operator entrypoints.

**Negative and abuse**
- 客服会话超时后仍有效
- 时间线排序掩盖退款先后
- 脱敏字段通过导出泄漏

**Mutation / anti-cheating**
- Mutation testing or targeted fault injection demonstrates that critical assertions fail when guards are removed.
- Reject empty assertions, skipped tests, hard-coded success, mocked-away domain state, untracked fixtures, and fake evidence.

## 15. Required artifacts and evidence

Place artifacts under `evidence/B82/` and reference them from `evidence/completion/B82.json`:

- `plan.md` — inspected facts, assumptions, file-level plan, risk, compatibility, and rollback.
- `commands.ndjson` — command, cwd, timestamps, exit code, stdout/stderr artifact paths.
- `test-results/` — machine-readable unit/integration/contract/E2E/negative/security/accessibility/performance results.
- `runtime/` — screenshots or response captures plus database/event/object/ledger/provider assertions.
- `security/` — authorization tests, scans, threat/privacy/vendor/compliance updates.
- `traceability.json` — requirement → file → symbol → test → evidence → commit.
- `completion-report.json` — schema-valid final report.
- No evidence may contain real customer media, secrets, payment credentials, or sensitive private content.

## 16. Acceptance criteria

- All requirements `B82-R01` through `B82-R05` have complete traceability and passing evidence.
- Repo-native build, lint, type, unit, integration, contract, relevant E2E, negative, security/privacy, accessibility/performance, and migration checks pass.
- Migrations apply from every supported previous version and a clean database; rollback/forward recovery is documented and tested where safe.
- No unresolved critical/high security, consent, privacy, child-safety, payment, finance, tenant-isolation, availability, accessibility, or data-loss finding remains.
- No placeholder, stub, silent fallback, disabled gate, hard-coded success, skipped critical test, or fake provider result exists in production paths.
- Observability and runbooks make failures diagnosable without exposing sensitive data.
- A clean checkout with documented commands reaches the same pass/fail conclusion.

## 17. Definition of Done

- Implementation, contracts, migrations, tests, fixtures, documentation, telemetry, feature flags, compatibility, and rollback are committed together.
- The diff is limited to declared scope or explicitly explains shared-contract changes.
- Completion report and evidence hashes validate with `scripts/verify_release.py --batch B82`.
- A reviewer other than the implementing Agent can reproduce the key result.
- Status is `passed` only after evidence validation; otherwise use `blocked` or `failed`.
