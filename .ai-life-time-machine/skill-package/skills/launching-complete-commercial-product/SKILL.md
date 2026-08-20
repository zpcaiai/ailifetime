---
name: launching-complete-commercial-product
description: Integrate and certify the complete commercial AI Life Time Machine product across web, mobile, mini-program, partners, payments, physical fulfillment, support, finance, data, and production rollout.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "完整商业项目集成、E2E 与分阶段上线"
  batches: "B125,B126,B127"
---

# 完整商业项目集成、E2E 与分阶段上线

用商业准备评审、全表面 E2E 和可回滚灰度发布签发最终项目证书。

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

- **B125 — 商业运营、政策、团队与供应商上线准备** (`references/B125-commercial-operations-readiness.md`; depends: B56,B62,B69,B72,B78,B86,B94,B102,B110,B118,B124)
- **B126 — 全终端、全渠道与周边系统商业 E2E 认证** (`references/B126-full-surface-commercial-e2e-certification.md`; depends: B48,B49,B125)
- **B127 — 分阶段生产发布、市场上线与最终证书** (`references/B127-staged-production-launch-certificate.md`; depends: B126)

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
