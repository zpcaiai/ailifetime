---
name: certifying-life-time-machine-release
description: Run fail-closed end-to-end business-loop certification and release evidence verification for the AI Life Time Machine, including abuse cases, partner settlement, recovery, deletion, observability, and clean-room reproducibility.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "商业闭环与生产发布认证"
  batches: "B48,B49"
disable-model-invocation: true
---

# 商业闭环与生产发布认证

只有所有证据可重放、业务闭环可核验时才允许发布。

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

- **B48 — 端到端商业闭环、渠道与滥用认证** (`references/B48-business-loop-e2e-certification.md`; depends: B10,B24,B30,B35,B36,B37,B38,B39,B40,B47)
- **B49 — 发布证据、清洁室复现与生产认证** (`references/B49-release-evidence-certification.md`; depends: B41,B43,B44,B45,B46,B47,B48,B50)

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
