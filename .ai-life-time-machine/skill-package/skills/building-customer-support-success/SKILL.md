---
name: building-customer-support-success
description: Build customer support and success operations: help center, ticketing, bot-to-human handoff, customer 360, controlled support actions, CRM, partner onboarding, VOC, and SLA governance.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "帮助中心、客服、CRM 与客户成功"
  batches: "B79,B80,B81,B82,B83,B84,B85,B86"
---

# 帮助中心、客服、CRM 与客户成功

把异常恢复、退款、删除、伙伴启用和客户成功纳入可运营商业系统。

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

- **B79 — 帮助中心、FAQ、搜索与自助排障** (`references/B79-help-center-faq-search.md`; depends: B58,B75)
- **B80 — 客服工单、全渠道收件箱、SLA 与路由** (`references/B80-support-ticket-inbox-sla-routing.md`; depends: B03,B30,B43,B74)
- **B81 — 站内帮助、客服机器人与人工接管** (`references/B81-in-app-support-bot-human-handoff.md`; depends: B23,B75,B79,B80)
- **B82 — 客户 360、时间线与受控代操作** (`references/B82-customer-360-timeline-impersonation.md`; depends: B03,B04,B11,B30,B43)
- **B83 — 客服动作、退款补发与数据权利协同** (`references/B83-support-actions-refund-replacement-data-rights.md`; depends: B28,B29,B30,B44,B80,B82)
- **B84 — 伙伴销售 CRM、线索、商机与报价** (`references/B84-partner-sales-crm-quotes-pipeline.md`; depends: B31,B32,B38,B62,B80)
- **B85 — 客户成功、伙伴启用、健康度与续约** (`references/B85-customer-success-onboarding-health-renewal.md`; depends: B34,B41,B76,B82,B84)
- **B86 — CSAT、NPS、VOC 与客服质量管理** (`references/B86-csat-nps-voc-support-quality.md`; depends: B41,B42,B80,B81,B85)

## Execution contract

1. Confirm the Batch is included in the active profile and all dependency reports are valid.
2. Inspect existing code and runtime evidence before proposing files; do not infer that reference paths already exist.
3. Produce a file-level plan with contracts, migrations, flags, permissions, failure behavior, tests, telemetry, rollback, and exact commands.
4. Implement the smallest complete vertical slice through every affected surface.
5. Run repository-native unit, integration, contract, E2E, negative, security/privacy, accessibility/performance, and migration checks relevant to the Batch.
6. Capture evidence under `evidence/<batch-id>/` and produce requirement-level traceability.
7. Run `python3 .ai-life-time-machine/skill-package/scripts/verify_release.py --repo . --batch <batch-id>`.
8. Leave a reviewable commit/PR. A prose claim such as “done” is never a state transition.

## Required completion behavior

- Do not mark work complete while required commands are unrun, failing, skipped, flaky, or mocked away.
- Do not overwrite unrelated uncommitted work or access production customer media/secrets.
- Record exact commands, exit codes, changed files, symbols, tests, runtime evidence, migrations, risks, rollback, and commit.
- Use `schemas/completion-report.schema.json` and `schemas/traceability.schema.json`.
- Keep real customer media, credentials, payment data, private conversations, and sensitive attributes out of evidence.
- After merge, refresh downstream branches and reevaluate profile readiness through `scripts/projectctl.py`.
