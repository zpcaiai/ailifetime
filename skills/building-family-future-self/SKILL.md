---
name: building-family-future-self
description: Build consented family graphs, multi-person family scenes, child safeguards, future-self narratives and dialogue, annual rituals, and long-term family memory experiences.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "家庭关系与未来自我"
  batches: "B19,B20,B21,B22,B23,B24"
---

# 家庭关系与未来自我

把一次性滤镜升级为家庭关系与未来自我的长期价值。

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

- **B19 — 家庭关系图、成员邀请与逐人同意** (`references/B19-family-graph-consent.md`; depends: B04,B11)
- **B20 — 多人家庭场景与共同变老作品** (`references/B20-multi-person-family-scenes.md`; depends: B15,B19)
- **B21 — 儿童与青少年专属安全机制** (`references/B21-child-safeguards.md`; depends: B04,B17,B19)
- **B22 — 未来自我故事、信件与目标可视化** (`references/B22-future-self-narrative.md`; depends: B11,B17)
- **B23 — 未来自我对话与拟人化交互安全** (`references/B23-future-self-dialogue-safeguards.md`; depends: B17,B22)
- **B24 — 年度更新、家庭仪式与长期档案** (`references/B24-annual-archive-rituals.md`; depends: B11,B20,B22,B23)

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
