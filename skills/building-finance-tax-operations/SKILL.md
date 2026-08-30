---
name: building-finance-tax-operations
description: Build auditable commercial finance operations including ledgers, reconciliation, invoices and fapiao, revenue recognition, disputes, partner payouts, cloud/AI FinOps, and month-end close.
metadata:
  package: ai-life-time-machine-commercial-project-factory
  version: "2.0.0"
  domain: "财务账本、对账、开票、税务与 FinOps"
  batches: "B87,B88,B89,B90,B91,B92,B93,B94"
---

# 财务账本、对账、开票、税务与 FinOps

让订单、退款、平台费、伙伴分账、供应商成本和财税报表能够闭环核对。

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

- **B87 — 复式账本、业务分录与不可变审计** (`references/B87-double-entry-ledger-subledger.md`; depends: B26,B34)
- **B88 — 支付、伙伴结算与银行对账** (`references/B88-payment-settlement-bank-reconciliation.md`; depends: B26,B34,B87)
- **B89 — 发票、收据、电子发票与税务配置** (`references/B89-invoice-receipt-fapiao-tax-profile.md`; depends: B25,B26,B31,B87)
- **B90 — 收入确认、递延收入、额度与礼品负债** (`references/B90-revenue-recognition-deferred-credit.md`; depends: B27,B28,B34,B87,B89)
- **B91 — 拒付、争议、欺诈损失与准备金** (`references/B91-chargeback-dispute-fraud-reserve.md`; depends: B26,B30,B43,B87,B88)
- **B92 — 伙伴付款、佣金、分成与扣缴单据** (`references/B92-partner-payout-commission-withholding.md`; depends: B34,B87,B88,B89)
- **B93 — 预算、FinOps、成本分摊与盈利分析** (`references/B93-budget-finops-cost-allocation-profitability.md`; depends: B18,B41,B45,B87,B90,B92)
- **B94 — 月结、审计导出与会计系统集成** (`references/B94-month-end-close-audit-accounting-integration.md`; depends: B88,B89,B90,B91,B92,B93)

## Execution contract

1. Confirm the Batch is included in the active profile and all dependency reports are valid.
2. Inspect existing code and runtime evidence before proposing files; do not infer that reference paths already exist.
3. Produce a file-level plan with contracts, migrations, flags, permissions, failure behavior, tests, telemetry, rollback, and exact commands.
4. Implement the smallest complete vertical slice through every affected surface.
5. Run repository-native unit, integration, contract, E2E, negative, security/privacy, accessibility/performance, and migration checks relevant to the Batch.
6. Capture evidence under `evidence/<batch-id>/` and produce requirement-level traceability.
7. Run `python3 skills/certifying-life-time-machine-release/scripts/verify_release.py --repo . --batch <batch-id>`.
8. Leave a reviewable commit/PR. A prose claim such as “done” is never a state transition.

## Required completion behavior

- Do not mark work complete while required commands are unrun, failing, skipped, flaky, or mocked away.
- Do not overwrite unrelated uncommitted work or access production customer media/secrets.
- Record exact commands, exit codes, changed files, symbols, tests, runtime evidence, migrations, risks, rollback, and commit.
- Use `schemas/completion-report.schema.json` and `schemas/traceability.schema.json`.
- Keep real customer media, credentials, payment data, private conversations, and sensitive attributes out of evidence.
- After merge, refresh downstream branches and reevaluate profile readiness through `scripts/projectctl.py`.
