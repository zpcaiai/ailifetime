---
name: building-mobile-and-mini-programs
description: Build production mobile applications and WeChat mini-program surfaces with secure capture, editing, purchases, notifications, deep links, release automation, and cross-platform entitlement consistency.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "iOS/Android App 与微信小程序"
  batches: "B63,B64,B65,B66,B67,B68,B69,B70,B71,B72"
---

# iOS/Android App 与微信小程序

把核心体验扩展到移动端和中国主流小程序生态，并完成商店发布闭环。

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

- **B63 — 移动端架构、认证、导航与离线基础** (`references/B63-mobile-architecture-auth-offline.md`; depends: B01,B03,B54)
- **B64 — 移动端拍摄、质量预检与断点上传** (`references/B64-mobile-capture-quality-resumable-upload.md`; depends: B05,B07,B63)
- **B65 — 移动端编辑、生成进度、作品库与导出** (`references/B65-mobile-editor-generation-library-export.md`; depends: B08,B09,B10,B11,B64)
- **B66 — 移动端内购、订阅与权益恢复** (`references/B66-mobile-iap-subscription-restore.md`; depends: B25,B26,B27,B63)
- **B67 — 移动推送、深链、组件与分享扩展** (`references/B67-mobile-push-deeplink-widgets-sharing.md`; depends: B40,B63,B65)
- **B68 — 移动端隐私、安全、性能与无障碍加固** (`references/B68-mobile-security-performance-accessibility.md`; depends: B21,B44,B55,B63,B64,B65,B66,B67)
- **B69 — 应用商店打包、审核与发布流水线** (`references/B69-mobile-store-packaging-review-release.md`; depends: B47,B56,B68)
- **B70 — 微信小程序登录、上传、编辑与生成** (`references/B70-wechat-mini-program-core-journey.md`; depends: B03,B04,B07,B08,B09,B54)
- **B71 — 微信支付、分享、客服与服务通知** (`references/B71-wechat-payment-share-service-messaging.md`; depends: B10,B25,B26,B27,B39,B70)
- **B72 — 小程序隐私、合规、审核与发布** (`references/B72-wechat-compliance-review-release.md`; depends: B44,B47,B55,B70,B71)

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
