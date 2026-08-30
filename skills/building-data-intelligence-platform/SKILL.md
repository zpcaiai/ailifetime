---
name: building-data-intelligence-platform
description: Build the governed data and intelligence platform for events, warehouse models, dashboards, attribution, unit economics, experimentation, data quality, privacy governance, and model evaluation.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "数据平台、指标、实验与模型评估"
  batches: "B111,B112,B113,B114,B115,B116,B117,B118"
---

# 数据平台、指标、实验与模型评估

以可信数据管理增长、收入、质量、安全和成本，而不是依赖不可复核的报表。

## Use this Skill when

- The selected project profile includes one of the Batches below.
- Claude Code or Codex must implement, adapt, test, review, or certify this domain in a real repository.
- The result requires production code, contracts, migrations, tests, observability, evidence, and a reversible handoff.

## Do not use this Skill to

- Produce only a brainstorm, mockup, pitch, or generic architecture without repository changes.
- Create a duplicate subsystem before inspecting B00 and the current repository.
- Bypass participant authorization, child protection, AI labels, deletion, tenant isolation, payment controls, or release evidence.
- Claim artistic age transformations predict real appearance, health, lifespan, occupation, wealth, or life outcome.
- Use face media, inferred traits, or future-self interactions for insurance underwriting, pricing, claims, credit, employment, medical, or other consequential eligibility decisions.

## Product invariants

1. **Illustrative, not predictive.** All future-looking media and narratives are clearly disclosed as AI-generated artistic simulations.
2. **Consent per person and purpose.** Every identifiable participant has purpose-specific, revocable authorization.
3. **Private by default.** Public sharing, marketing reuse, voice cloning, long-term memory, and partner reuse are separate choices.
4. **Revocable and deletable.** Shares, permissions, media, vendor copies, derived assets, and partner access have executable revocation paths.
5. **No biometric decisioning.** Facial or interaction data never drives consequential decisions.
6. **Safety cannot be purchased away.** Plans, white labels, and contracts cannot disable safety, provenance, consent, or child controls.
7. **Financial and external side effects are controlled.** Writes are authorized, idempotent, auditable, retry-bounded, and reconcilable.
8. **Evidence over assertion.** A Batch passes only when an independent reviewer can reproduce the result.

## Source-of-truth order

1. Current repository code, migrations, tests, deployed contracts, and B00 inventory.
2. The selected `profiles/*.json` and `stack-profiles/*.json` files.
3. Validated dependency completion reports and evidence hashes.
4. Versioned package contracts, schemas, and the selected Batch reference.
5. Reference architecture and examples in this package.

When sources conflict, preserve active production compatibility, document the conflict, and make the smallest explicit migration. Never silently select the easiest interpretation.

## Batches in this Skill

- **B111 — 事件分类、埋点 SDK 与 Schema Registry** (`references/B111-event-taxonomy-tracking-sdk-schema-registry.md`; depends: B02,B41,B54)
- **B112 — 数据采集、仓库、转换与语义层** (`references/B112-warehouse-ingestion-dbt-semantic-layer.md`; depends: B41,B111)
- **B113 — 产品、交易、伙伴与运营仪表板** (`references/B113-product-commerce-partner-ops-dashboards.md`; depends: B34,B43,B45,B87,B112)
- **B114 — 归因、队列、留存与 LTV 分析** (`references/B114-attribution-cohort-retention-ltv.md`; depends: B39,B40,B59,B60,B78,B112)
- **B115 — 收入、AI/履约成本与单位经济** (`references/B115-revenue-cost-unit-economics-margins.md`; depends: B18,B34,B87,B93,B102,B112)
- **B116 — 实验平台、统计与安全护栏** (`references/B116-experimentation-statistics-guardrails.md`; depends: B42,B56,B78,B111,B112)
- **B117 — 数据质量、血缘、目录与 PII 治理** (`references/B117-data-quality-lineage-catalog-pii-governance.md`; depends: B44,B46,B111,B112)
- **B118 — AI 模型评测、漂移、基准与人工评分** (`references/B118-ai-model-evals-drift-human-rating.md`; depends: B14,B15,B16,B17,B18,B43,B112,B117)

## Execution contract

1. Confirm the Batch is included in the active profile and all dependency reports are valid.
2. Inspect existing code and runtime evidence before proposing files; do not infer that reference paths already exist.
3. Produce a file-level plan with contracts, migrations, flags, permissions, failure behavior, tests, telemetry, rollback, and exact commands.
4. Implement the smallest complete vertical slice through every affected surface.
5. Run repository-native unit, integration, contract, E2E, negative, security/privacy, accessibility/performance, and migration checks relevant to the Batch.
6. Capture evidence under `evidence/<batch-id>/` and produce requirement-level traceability.
7. Run `python3 skills/certifying-life-time-machine-release/scripts/verify_release.py --repo . --batch <batch-id>`.
8. Leave a reviewable commit/PR. A prose claim such as “done” is never a state transition.

## Required completion behavior

- Do not mark work complete while required commands are unrun, failing, skipped, flaky, or mocked away.
- Do not overwrite unrelated uncommitted work or access production customer media/secrets.
- Record exact commands, exit codes, changed files, symbols, tests, runtime evidence, migrations, risks, rollback, and commit.
- Use `schemas/completion-report.schema.json` and `schemas/traceability.schema.json`.
- Keep real customer media, credentials, payment data, private conversations, and sensitive attributes out of evidence.
- After merge, refresh downstream branches and reevaluate profile readiness through `scripts/projectctl.py`.
