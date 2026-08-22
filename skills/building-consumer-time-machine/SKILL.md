---
name: building-consumer-time-machine
description: Build the consumer acquisition, upload, editing, generation status, sharing, export, account, and family-library experience for an AI 0–100 age timeline product.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "消费者人生时光机"
  batches: "B06,B07,B08,B09,B10,B11"
---

# 消费者人生时光机

把照片上传转化为可传播、可付费、可留存的消费者体验。

## Use this Skill when

- The repository is implementing, extending, reviewing, or certifying the AI 人生时光机 product described by this package.
- The task matches one of the Batches listed below.
- The result must be production-oriented code, contracts, tests, evidence, and a reviewable handoff.

## Do not use this Skill to

- Produce only a brainstorm, pitch deck, or generic architecture with no repository changes.
- Bypass participant authorization, AI generation labels, child safeguards, regulated-use boundaries, or release evidence.
- Replace a working project architecture merely because the reference stack differs.
- Claim that generated ages predict the person’s actual future appearance, health, lifespan, wealth, or life outcome.
- use facial media, quality scores, or future-self interactions for insurance underwriting, pricing, eligibility, claims, employment, credit, or medical decisions.

## Product invariants

1. **Illustrative, not predictive.** Every age result and future-life scene is clearly presented as AI-created artistic simulation.
2. **Consent per person and purpose.** Uploading a group photo does not grant unlimited rights over every person in it.
3. **Private by default.** Sharing, public discovery, marketing use, voice cloning, and long-term memory require separate choices.
4. **Revocable and deletable.** Shares, processing permissions, media, downstream copies, and partner access have executable revocation paths.
5. **No biometric decisioning.** Face data and inferred signals never drive regulated or consequential decisions.
6. **Safety cannot be purchased away.** Paid plans and partner contracts cannot disable authorization, content safety, provenance, or child controls.
7. **Evidence over assertion.** A Batch passes only when its implementation and evidence can be independently reproduced.

## Source-of-truth order

1. Current repository code, migrations, tests, and deployed contract.
2. B00 baseline and validated completion reports from dependency Batches.
3. Versioned files in `<repo>/.ai-life-time-machine/skill-package/contracts/` and `schemas/`.
4. The selected Batch reference in this Skill.
5. Reference architecture and examples in the package.

When sources conflict, do not silently choose. Preserve current production compatibility, document the conflict, and make the smallest explicit migration.

## Batches in this Skill

- **B06 — 获客落地页、匿名体验与账户升级** (`references/B06-acquisition-guest-journey.md`; depends: B02,B03,B04)
- **B07 — 照片采集、人物检测与质量预检** (`references/B07-photo-intake-quality.md`; depends: B05,B06)
- **B08 — 年龄轴编辑器、模板与场景编排** (`references/B08-editor-template-composer.md`; depends: B07)
- **B09 — 生成任务、进度、取消与恢复** (`references/B09-generation-job-status-recovery.md`; depends: B08,B12,B13)
- **B10 — 作品导出、可撤销分享与 AI 标识** (`references/B10-export-share-labels.md`; depends: B09,B17)
- **B11 — 账户、家庭作品库与资产归档** (`references/B11-account-family-library.md`; depends: B03,B10)

## Domain execution pattern

1. Inspect B00 evidence and all dependency completion reports.
2. Select the smallest ready Batch in this domain; do not implement several Batches as one unreviewable diff.
3. Load its reference file and treat its five requirement IDs as mandatory.
4. Reuse existing architecture and contracts; propose a contract change before writing incompatible code.
5. Implement a vertical, runnable slice and then complete edge cases, recovery, security, telemetry, and docs.
6. Run repo-native acceptance commands plus the Batch-specific negative and mutation checks.
7. Produce a schema-valid completion report with requirement-to-evidence traceability.
8. Stop with `blocked` rather than inventing credentials, pretending an external system succeeded, or disabling a gate.

## Required completion behavior

- Do not mark work complete while required commands are unrun, failing, skipped, flaky, or mocked away.
- Do not overwrite unrelated uncommitted work.
- Record exact commands, exit codes, changed files, entrypoints, tests, runtime evidence, migrations, risks, and commit.
- Use `schemas/completion-report.schema.json` and `schemas/traceability.schema.json`.
- Keep sensitive media and secrets out of evidence.
- Run `python3 .ai-life-time-machine/skill-package/scripts/verify_release.py --repo . --batch Bxx` before declaring a Batch passed.
