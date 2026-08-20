---
name: building-physical-supply-network
description: Build the physical-goods supply network for photo books, frames, gifts, proofs, vendors, production routing, shipping, inventory, returns, replacements, and supplier quality.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "照片书、相框与实物供应链"
  batches: "B95,B96,B97,B98,B99,B100,B101,B102"
---

# 照片书、相框与实物供应链

将数字作品扩展为可配置、可生产、可追踪、可售后的纪念礼品业务。

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

- **B95 — 印刷商品配置器、版式、出血与色彩预检** (`references/B95-print-product-configurator-preflight.md`; depends: B08,B25,B29,B54)
- **B96 — 供应商入驻、目录、价格、产能与 SLA** (`references/B96-vendor-onboarding-catalog-capacity-sla.md`; depends: B29,B31,B32,B95)
- **B97 — 生产打样、校样与客户批准** (`references/B97-production-proof-customer-approval.md`; depends: B28,B29,B95,B96)
- **B98 — 订单路由、采购单与供应商生产任务** (`references/B98-order-routing-purchase-orders-vendor-jobs.md`; depends: B13,B29,B96,B97)
- **B99 — 地址校验、承运商、发货与物流追踪** (`references/B99-address-carrier-shipping-tracking.md`; depends: B29,B74,B98)
- **B100 — 库存、耗材、可售量与预售** (`references/B100-inventory-material-stock-preorder.md`; depends: B25,B96,B98)
- **B101 — 退货、补发、破损、丢件与理赔** (`references/B101-returns-replacements-loss-damage-claims.md`; depends: B30,B80,B83,B99,B100)
- **B102 — 供应商质量、SLA、评分与结算协同** (`references/B102-vendor-quality-sla-scorecard-settlement.md`; depends: B34,B41,B92,B96,B98,B99,B101)

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
