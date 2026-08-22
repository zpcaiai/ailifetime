---
name: building-notification-lifecycle-platform
description: Build a consent-aware multi-channel notification and lifecycle platform covering preferences, templates, journeys, deliverability, retries, suppression, experimentation, and analytics.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "消息通知与用户生命周期平台"
  batches: "B73,B74,B75,B76,B77,B78"
---

# 消息通知与用户生命周期平台

支持生成完成、订单、家庭邀请、年度更新、客服和营销触达，同时避免骚扰和重复发送。

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

- **B73 — 通知偏好、同意、安静时段与频控** (`references/B73-notification-preferences-consent-quiet-hours.md`; depends: B03,B04,B40)
- **B74 — 邮件、短信、推送、微信与站内信供应商路由** (`references/B74-multi-channel-notification-provider-routing.md`; depends: B12,B13,B73)
- **B75 — 通知模板、变量安全、本地化与渲染** (`references/B75-notification-template-localization-rendering.md`; depends: B55,B74)
- **B76 — 生命周期旅程、调度与状态编排** (`references/B76-lifecycle-journey-orchestration.md`; depends: B24,B27,B40,B74,B75)
- **B77 — 送达率、退信投诉与供应商故障治理** (`references/B77-deliverability-bounce-complaint-failover.md`; depends: B45,B74,B75,B76)
- **B78 — 通知分析、实验、频率与增量效果** (`references/B78-notification-analytics-experiments-frequency.md`; depends: B41,B42,B73,B76,B77)

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
