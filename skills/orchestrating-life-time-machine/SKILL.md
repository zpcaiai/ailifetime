---
name: orchestrating-life-time-machine
description: Orchestrate the complete AI Life Time Machine build in Claude Code or Codex: inspect an existing repository, select ready batches, isolate worktrees, enforce evidence, and drive the product from baseline through certified release.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "AI 人生时光机总控编排"
  batches: "B00,B50"
---

# AI 人生时光机总控编排

负责仓库基线、依赖调度、多 Agent/Worktree、完成报告与全局商业闭环，不直接替代各领域 Skill。

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

- **B00 — 仓库发现、现状审计与可执行基线** (`references/B00-repository-discovery-baseline.md`; depends: none)
- **B50 — 多 Agent、Worktree、PR 与断点续作编排** (`references/B50-multi-agent-worktree-pr-resume.md`; depends: B00,B01,B02,B13)

## Orchestration algorithm

1. Run B00 or inspect its current completion report; never infer repository state from this package alone.
2. Read `<repo>/.ai-life-time-machine/skill-package/manifests/batches.json` and the state file.
3. Validate dependency completion reports and evidence hashes.
4. Select a **ready** Batch whose file ownership does not overlap another running Batch.
5. Create or reuse an isolated branch/worktree; snapshot base commit and contract versions.
6. Load exactly one domain Skill and one Batch reference. Load additional references only when the Batch links to them.
7. Require a file-level implementation plan before edits.
8. Implement, test, repair within bounded loops, and generate the completion report.
9. Run the Batch verifier. A verbal statement such as “done” is not a state transition.
10. Open a reviewable commit/PR; after merge, refresh downstream base commits and mark newly unblocked Batches ready.

Use `python3 .ai-life-time-machine/skill-package/scripts/orchestrate_batches.py --repo . ready`
to inspect readiness after installation.

## Required completion behavior

- Do not mark work complete while required commands are unrun, failing, skipped, flaky, or mocked away.
- Do not overwrite unrelated uncommitted work.
- Record exact commands, exit codes, changed files, entrypoints, tests, runtime evidence, migrations, risks, and commit.
- Use `schemas/completion-report.schema.json` and `schemas/traceability.schema.json`.
- Keep sensitive media and secrets out of evidence.
- Run `python3 .ai-life-time-machine/skill-package/scripts/verify_release.py --repo . --batch Bxx` before declaring a Batch passed.
