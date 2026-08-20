---
name: hardening-enterprise-platform
description: Harden the complete platform with configuration and secrets governance, multi-region resilience, performance and capacity engineering, chaos testing, security assurance, and compliance evidence automation.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "企业级配置、韧性、性能与合规证据"
  batches: "B119,B120,B121,B122,B123,B124"
---

# 企业级配置、韧性、性能与合规证据

使系统能够在企业客户、跨区域、高并发和严格审计环境中稳定运营。

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

- **B119 — 环境、配置、秘密与租户设置治理** (`references/B119-environment-config-secrets-tenant-settings.md`; depends: B03,B31,B44,B47)
- **B120 — 多区域、中国/全球拓扑、CDN 与域名** (`references/B120-multi-region-china-global-topology-cdn.md`; depends: B05,B44,B45,B46,B47,B119)
- **B121 — 性能、压力、容量与自动扩缩容** (`references/B121-performance-load-capacity-autoscaling.md`; depends: B18,B45,B47,B69,B72,B120)
- **B122 — 韧性、混沌、依赖故障与切换** (`references/B122-resilience-chaos-dependency-failover.md`; depends: B13,B45,B46,B47,B74,B98,B120,B121)
- **B123 — 软件供应链、SBOM、SAST/DAST 与渗透测试** (`references/B123-supply-chain-security-sbom-sast-dast-pentest.md`; depends: B44,B47,B69,B72,B103,B119)
- **B124 — 合规证据、记录、备案评估与审计导出** (`references/B124-compliance-evidence-filings-audit-exports.md`; depends: B44,B46,B49,B69,B72,B89,B94,B110,B117,B123)

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
