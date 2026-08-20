---
name: building-developer-integration-platform
description: Build the external developer platform with documentation, sandbox, API credentials, SDKs, webhook delivery, connectors, certification, lifecycle governance, and enterprise adapters.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "开发者门户、SDK、Webhook 与连接器"
  batches: "B103,B104,B105,B106,B107,B108,B109,B110"
---

# 开发者门户、SDK、Webhook 与连接器

让影楼、礼品、保险养老、企业福利和其他伙伴能够安全、自助、稳定地集成。

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

- **B103 — 开发者门户、API 文档与沙箱** (`references/B103-developer-portal-api-docs-sandbox.md`; depends: B33,B54,B58)
- **B104 — API 密钥、OAuth、服务账户与细粒度 Scope** (`references/B104-api-keys-oauth-service-accounts-scopes.md`; depends: B03,B31,B33,B103)
- **B105 — 多语言 SDK 生成、版本与示例工程** (`references/B105-sdk-generation-versioning-examples.md`; depends: B33,B103,B104)
- **B106 — Webhook 控制台、签名、重放与死信** (`references/B106-webhook-console-replay-dlq-signature.md`; depends: B13,B33,B43,B103,B104)
- **B107 — 连接器框架与集成市场** (`references/B107-connector-framework-integration-marketplace.md`; depends: B12,B13,B33,B103,B104,B106)
- **B108 — CRM、CDP、营销、客服与会计适配器** (`references/B108-business-system-adapters.md`; depends: B38,B60,B80,B84,B94,B107)
- **B109 — 伙伴测试工具、合成数据与集成认证** (`references/B109-partner-test-harness-certification.md`; depends: B33,B43,B103,B104,B105,B106,B107)
- **B110 — API 生命周期、弃用、变更日志与支持 SLA** (`references/B110-api-lifecycle-deprecation-status-support.md`; depends: B45,B62,B103,B105,B106,B109)

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
