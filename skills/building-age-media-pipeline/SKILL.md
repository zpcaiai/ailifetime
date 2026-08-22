---
name: building-age-media-pipeline
description: Build provider-neutral image and video generation pipelines for illustrative 0–100 age transformations with identity consistency, quality gates, provenance, safety, cost controls, and deterministic recovery.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "年龄影像生成流水线"
  batches: "B14,B15,B16,B17,B18"
---

# 年龄影像生成流水线

实现高一致性照片/视频生成，但不宣称预测未来容貌。

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

- **B14 — 0–100 岁示意性年龄时间轴生成** (`references/B14-age-timeline-generation.md`; depends: B07,B12,B13)
- **B15 — 身份一致性、年龄合理性与质量门控** (`references/B15-identity-consistency-quality.md`; depends: B14)
- **B16 — 年龄变化视频、音频与字幕流水线** (`references/B16-video-audio-caption-pipeline.md`; depends: B14,B15)
- **B17 — 内容安全、来源证明与生成合成标识** (`references/B17-safety-provenance-labeling.md`; depends: B04,B05,B14,B16)
- **B18 — 成本、延迟、配额与安全缓存** (`references/B18-cost-latency-cache.md`; depends: B12,B13,B14,B15,B16)

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
