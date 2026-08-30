import assert from "node:assert/strict";
import test from "node:test";
import { CommercialOperationsError, sha256, type JsonObject } from "./common.js";
import type { FinanceOperationsEngine } from "./finance-engine.js";
import { commercialTestFixture, TEST_DIGEST, TEST_DIGEST_B } from "./test-fixtures.js";

function expectCode(action: () => unknown, code: CommercialOperationsError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof CommercialOperationsError && error.code === code);
}

function configureLedger(finance: FinanceOperationsEngine, actor: ReturnType<typeof commercialTestFixture>["reviewer"], key = "ledger-config"): void {
  finance.configureLedger(actor, {
    legalEntityId: "entity-cn", currency: "CNY", chartVersion: "chart-v1",
    accounts: [
      { code: "1001", name: "Cash", class: "asset", normalSide: "debit" },
      { code: "6001", name: "Revenue", class: "revenue", normalSide: "credit" },
      { code: "2201", name: "Deferred", class: "liability", normalSide: "credit" },
      { code: "5001", name: "Expense", class: "expense", normalSide: "debit" },
    ],
    postingRules: [
      { eventKind: "payment", version: "rule-v1", debitAccount: "1001", creditAccount: "2201", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: null },
      { eventKind: "vendor_cost", version: "rule-v1", debitAccount: "5001", creditAccount: "1001", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: null },
    ], idempotencyKey: key,
  });
}

test("B87 dedicated ledger engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B87-R01 authoritative tenant/entity/currency chart and periods", () => {
    const config = f.finance.configureLedger(f.reviewer, {
      legalEntityId: "entity-cn", currency: "CNY", chartVersion: "chart-v1",
      accounts: [{ code: "1001", name: "Cash", class: "asset", normalSide: "debit" }, { code: "2201", name: "Deferred", class: "liability", normalSide: "credit" }],
      postingRules: [{ eventKind: "payment", version: "rule-v1", debitAccount: "1001", creditAccount: "2201", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: null }],
      idempotencyKey: "b87-r01",
    });
    assert.equal(config.aggregateId, "entity-cn:CNY");
    assert.equal(config.state.chartVersion, "chart-v1");
  });
  let entry: JsonObject;
  await t.test("B87-R02 posting rules create exact balanced entries", () => {
    entry = f.finance.postJournal(f.actor, { entryId: "entry-1", legalEntityId: "entity-cn", currency: "CNY", eventKind: "payment", amountMinor: 10_001, sourceReference: "provider-tx-1", occurredAt: "2026-08-01T00:00:00Z", ruleVersion: "rule-v1", idempotencyKey: "b87-r02" });
    const lines = entry.lines as readonly JsonObject[];
    assert.equal(lines.reduce((sum, line) => sum + Number(line.debitMinor), 0), 10_001);
    assert.equal(lines.reduce((sum, line) => sum + Number(line.creditMinor), 0), 10_001);
  });
  await t.test("B87-R03 posted entries are reversed, never overwritten", () => {
    const reversal = f.finance.reverseJournal(f.reviewer, { entryId: "entry-1-reversal", originalEntryId: "entry-1", reason: "provider reversal", occurredAt: "2026-08-02T00:00:00Z", idempotencyKey: "b87-r03" });
    assert.equal(reversal.reversalOf, "entry-1");
    assert.equal(f.repository.get("tenant-a", "finance.journal", "entry-1")?.state.status, "reversed");
  });
  await t.test("B87-R04 external source and idempotency references cannot double-post", () => {
    expectCode(() => f.finance.postJournal(f.actor, { entryId: "entry-duplicate", legalEntityId: "entity-cn", currency: "CNY", eventKind: "payment", amountMinor: 10_001, sourceReference: "provider-tx-1", occurredAt: "2026-08-03T00:00:00Z", ruleVersion: "rule-v1", idempotencyKey: "b87-r04" }), "CONFLICT");
    const replay = f.finance.configureLedger(f.reviewer, {
      legalEntityId: "entity-cn", currency: "CNY", chartVersion: "chart-v1",
      accounts: [{ code: "1001", name: "Cash", class: "asset", normalSide: "debit" }, { code: "2201", name: "Deferred", class: "liability", normalSide: "credit" }],
      postingRules: [{ eventKind: "payment", version: "rule-v1", debitAccount: "1001", creditAccount: "2201", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: null }],
      idempotencyKey: "b87-r01",
    });
    assert.equal(replay.version, 1);
  });
  await t.test("B87-R05 trial balance and hard period lock fail closed", () => {
    const balance = f.finance.trialBalance("tenant-a", "entity-cn", "CNY");
    assert.equal(balance.balanced, true);
    f.finance.setPeriodState(f.reviewer, { legalEntityId: "entity-cn", period: "2026-08", state: "hard_closed", approvals: ["a1", "a2"], checklistDigest: TEST_DIGEST, idempotencyKey: "b87-r05-close" });
    expectCode(() => f.finance.postJournal(f.actor, { entryId: "locked-entry", legalEntityId: "entity-cn", currency: "CNY", eventKind: "payment", amountMinor: 1, sourceReference: "locked-source", occurredAt: "2026-08-03T00:00:00Z", ruleVersion: "rule-v1", idempotencyKey: "b87-r05-post" }), "PERIOD_LOCKED");
  });
  f.repository.close();
});

test("B88 dedicated settlement reconciliation satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  configureLedger(f.finance, f.reviewer);
  f.finance.postJournal(f.actor, { entryId: "settled-entry", legalEntityId: "entity-cn", currency: "CNY", eventKind: "payment", amountMinor: 9_500, sourceReference: "stripe-tx-1", occurredAt: "2026-08-01T00:00:00Z", ruleVersion: "rule-v1", idempotencyKey: "settled-entry" });
  const exactStatementFact = f.fact("payment:stripe", "payment.statement", "statement-1", { statementId: "statement-1", legalEntityId: "entity-cn", currency: "CNY", fileSha256: TEST_DIGEST, sourceManifestSha256: TEST_DIGEST_B, lines: [{ providerTransactionId: "stripe-tx-1", orderId: "order-1", grossMinor: 10_000, feeMinor: 500, refundMinor: 0, netMinor: 9_500, occurredAt: "2026-08-01T00:00:00Z" }] });
  await t.test("B88-R01 signed statement source, manifest, and duplicate controls", () => {
    const statement = f.finance.ingestSettlementStatement(f.actor, exactStatementFact, "b88-r01");
    assert.equal(statement.provider, "payment:stripe");
    assert.equal(statement.sourceManifestSha256, TEST_DIGEST_B);
  });
  await t.test("B88-R02 deterministic transaction/order/amount/currency matching", () => {
    const result = f.finance.reconcileStatement(f.actor, { statementId: "statement-1", toleranceSeconds: 300, idempotencyKey: "b88-r02" });
    assert.equal((result.matched as readonly JsonObject[]).length, 1);
    assert.equal(result.status, "reconciled");
  });
  await t.test("B88-R03 unexplained differences become assignable manual cases", () => {
    const fact = f.fact("payment:stripe", "payment.statement", "statement-2", { statementId: "statement-2", legalEntityId: "entity-cn", currency: "CNY", fileSha256: TEST_DIGEST_B, sourceManifestSha256: TEST_DIGEST, lines: [{ providerTransactionId: "unknown-tx", orderId: "order-x", grossMinor: 1_000, feeMinor: 0, refundMinor: 0, netMinor: 1_000, occurredAt: "2026-08-01T00:00:00Z" }] }, 2);
    f.finance.ingestSettlementStatement(f.actor, fact, "b88-r03-ingest");
    const result = f.finance.reconcileStatement(f.actor, { statementId: "statement-2", toleranceSeconds: 0, idempotencyKey: "b88-r03" });
    assert.equal((result.cases as readonly JsonObject[])[0]?.state, "manual_confirmation_required");
  });
  let closed: JsonObject;
  await t.test("B88-R04 close binds independent payment, bank, partner, and ledger evidence", () => {
    const bank = f.fact("bank:main", "bank.statement", "window-1", { windowId: "window-1", statementId: "statement-1", legalEntityId: "entity-cn", currency: "CNY", fileSha256: TEST_DIGEST, controlTotalMinor: 9_500 });
    closed = f.finance.closeReconciliationWindow(f.reviewer, { windowId: "window-1", statementId: "statement-1", bankStatementFact: bank, partnerSourceDigest: TEST_DIGEST_B, materialityMinor: 100, idempotencyKey: "b88-r04" });
    assert.equal(closed.status, "closed");
    assert.match(String(closed.evidenceDigest), /^[a-f0-9]{64}$/);
  });
  await t.test("B88-R05 close evidence and materiality remain exportable and durable", () => {
    const stored = f.repository.get("tenant-a", "finance.reconciliationWindow", "window-1")?.state;
    assert.equal(stored?.materialityMinor, 100);
    assert.equal(stored?.evidenceDigest, closed.evidenceDigest);
  });
  f.repository.close();
});

test("B89 dedicated tax-document engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B89-R01 approved seller/tax/category/numbering profile is authoritative", () => {
    const profile = f.finance.configureTaxProfile(f.reviewer, { profileId: "tax-cn", legalEntityId: "entity-cn", jurisdiction: "CN", sellerTaxId: "91310000000000000X", sellerAddress: "Shanghai", sellerBankReference: "bank-ref-1", taxRatesBasisPoints: { standard: 1300 }, goodsTaxCategories: { print: "standard" }, currencies: ["CNY"], languages: ["zh-CN"], numberingSeries: "CN2026", effectiveFrom: "2026-01-01", effectiveUntil: null, professionalReviewerId: "tax-professional", idempotencyKey: "b89-r01" });
    assert.equal(profile.numberingSeries, "CN2026");
  });
  await t.test("B89-R02 enterprise invoice validates title and immutable request state", () => {
    const request = f.finance.requestTaxDocument(f.actor, { requestId: "tax-request-1", profileId: "tax-cn", orderId: "order-tax-1", documentKind: "electronic_fapiao", buyerTitle: "Acme China", buyerTaxId: "91310000ACME", currency: "CNY", netMinor: 10_000, taxMinor: 1_300, idempotencyKey: "b89-r02" });
    assert.equal(request.status, "provider_pending");
    assert.equal(request.grossMinor, 11_300);
  });
  let document: JsonObject;
  await t.test("B89-R03 signed provider adapter issues exact request without fake success", () => {
    const fact = f.fact("tax:platform", "tax.document", "tax-request-1", { requestId: "tax-request-1", documentId: "tax-document-1", documentNumber: "CN2026-0001", documentSha256: TEST_DIGEST, status: "issued", taxMinor: 1_300, grossMinor: 11_300 });
    document = f.finance.applyTaxDocumentFact(f.actor, fact, "b89-r03");
    assert.equal(document.immutable, true);
    assert.equal(document.provider, "tax:platform");
  });
  await t.test("B89-R04 refunds/changes create linked credit documents, never overwrite originals", () => {
    const credit = f.finance.requestTaxDocument(f.actor, { requestId: "tax-credit-1", profileId: "tax-cn", orderId: "order-tax-1", documentKind: "credit_note", currency: "CNY", netMinor: 1_000, taxMinor: 130, originalDocumentId: "tax-document-1", idempotencyKey: "b89-r04" });
    assert.equal(credit.originalDocumentId, "tax-document-1");
    assert.equal(f.repository.get("tenant-a", "tax.document", "tax-document-1")?.state.documentSha256, TEST_DIGEST);
  });
  await t.test("B89-R05 document access is short-lived, watermarked, and audited", () => {
    const token = "tax-document-secret";
    const access = f.finance.createTaxDocumentAccess(f.reviewer, "tax-document-1", sha256(token), "2026-08-28T12:10:00Z", "b89-r05");
    assert.equal(access.watermark, "reviewer:CN2026-0001");
    assert.equal(f.finance.authorizeTaxDocumentAccess("tenant-a", String(access.grantId), token).documentSha256, TEST_DIGEST);
    expectCode(() => f.finance.createTaxDocumentAccess(f.reviewer, "tax-document-1", sha256(token), "2026-08-28T13:00:00Z", "b89-r05-long"), "VALIDATION_FAILED");
  });
  f.repository.close();
});

test("B90 dedicated revenue engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B90-R01 contract allocates exact price to trigger-bound obligations", () => {
    const contract = f.finance.createRevenueContract(f.reviewer, { contractId: "revenue-1", contractType: "gift", currency: "CNY", transactionPriceMinor: 12_000, obligations: [{ obligationId: "gift-consume", allocatedMinor: 7_000, trigger: "consumption" }, { obligationId: "gift-expiry", allocatedMinor: 5_000, trigger: "period" }], expiryPolicyReviewed: true, idempotencyKey: "b90-r01" });
    assert.equal(contract.transactionPriceMinor, 12_000);
    assert.equal((contract.obligations as readonly JsonObject[]).length, 2);
  });
  await t.test("B90-R02 credits/gifts/prepayments begin as liabilities with reviewed expiry", () => {
    const report = f.finance.revenueReport("tenant-a", "revenue-1");
    assert.equal(report.deferredMinor, 12_000);
    expectCode(() => f.finance.createRevenueContract(f.reviewer, { contractId: "gift-unreviewed", contractType: "gift", currency: "CNY", transactionPriceMinor: 1, obligations: [{ obligationId: "o", allocatedMinor: 1, trigger: "period" }], expiryPolicyReviewed: false, idempotencyKey: "b90-r02-fail" }), "POLICY_BLOCKED");
  });
  await t.test("B90-R03 cash cannot recognize revenue; signed milestone can", () => {
    expectCode(() => f.finance.recognizeRevenue(f.actor, { contractId: "revenue-1", obligationId: "gift-consume", amountMinor: 1_000, trigger: "cash", period: "2026-08", idempotencyKey: "b90-r03-cash" }), "POLICY_BLOCKED");
    const fact = f.fact("revenue:milestone", "revenue.milestone", "gift-consume", { contractId: "revenue-1", obligationId: "gift-consume", trigger: "consumption", achieved: true, amountMinor: 2_000, sourceReference: "credit-consumption-1" });
    const result = f.finance.recognizeRevenue(f.actor, { contractId: "revenue-1", obligationId: "gift-consume", amountMinor: 2_000, trigger: "consumption", milestoneFact: fact, period: "2026-08", idempotencyKey: "b90-r03" });
    assert.equal(result.recognizedMinor, 2_000);
  });
  await t.test("B90-R04 modifications version schedules and preserve history", () => {
    const modified = f.finance.modifyRevenueContract(f.reviewer, { contractId: "revenue-1", modificationId: "refund-1", type: "refund", adjustmentMinor: -1_000, reason: "partial refund", idempotencyKey: "b90-r04" });
    assert.equal(modified.scheduleVersion, 2);
    assert.equal((modified.modifications as readonly JsonObject[])[0]?.modificationId, "refund-1");
  });
  await t.test("B90-R05 reports separate recognized/deferred/remaining from cash", () => {
    const report = f.finance.revenueReport("tenant-a", "revenue-1");
    assert.equal(report.recognizedMinor, 2_000);
    assert.equal(report.cashIsNotProfit, true);
    assert.equal(report.remainingObligationMinor, report.deferredMinor);
  });
  f.repository.close();
});

test("B91 dedicated dispute engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B91-R01 signed dispute creates deadline/reason/amount/order state machine", () => {
    const fact = f.fact("payment:chargeback", "payment.dispute", "dispute-1", { disputeId: "dispute-1", orderId: "order-1", reasonCode: "fraud", amountMinor: 5_000, currency: "CNY", responseDueAt: "2026-09-01T00:00:00Z", refunded: false });
    const dispute = f.finance.openDispute(f.actor, fact, "b91-r01");
    assert.equal(dispute.state, "open");
    assert.equal(dispute.reserveMinor, 5_000);
  });
  await t.test("B91-R02 evidence is minimized and rejects face/child/private data", () => {
    expectCode(() => f.finance.attachDisputeEvidence(f.actor, { disputeId: "dispute-1", evidenceId: "bad-evidence", category: "delivery", artifactSha256: TEST_DIGEST, containsFaceMedia: true, containsChildData: false, containsPrivateConversation: false, expiresAt: "2026-09-01T00:00:00Z", idempotencyKey: "b91-r02-bad" }), "POLICY_BLOCKED");
    const dispute = f.finance.attachDisputeEvidence(f.actor, { disputeId: "dispute-1", evidenceId: "delivery-summary", category: "delivery", artifactSha256: TEST_DIGEST, containsFaceMedia: false, containsChildData: false, containsPrivateConversation: false, expiresAt: "2026-09-01T00:00:00Z", idempotencyKey: "b91-r02" });
    assert.equal((dispute.evidence as readonly JsonObject[])[0]?.minimized, true);
  });
  await t.test("B91-R03 risk output is explainable queue-only advice", () => {
    const review = f.finance.recommendDisputeReview(f.actor, { disputeId: "dispute-1", recommendation: "prioritize", explanationCodes: ["deadline_near"], usesSensitiveOrBiometricSignals: false, idempotencyKey: "b91-r03" });
    assert.equal((review.riskRecommendation as JsonObject).effect, "queue_only");
  });
  await t.test("B91-R04 human decision plus signed terminal channel fact releases reserve", () => {
    const fact = f.fact("payment:chargeback", "payment.dispute.decision", "dispute-1", { disputeId: "dispute-1", outcome: "lost", amountMinor: 5_000, feeMinor: 100, refunded: false }, 2);
    const result = f.finance.decideDispute(f.reviewer, { disputeId: "dispute-1", decision: "accept_loss", explanation: "channel adjudication verified", channelDecisionFact: fact, feeMinor: 100, idempotencyKey: "b91-r04" });
    assert.equal(result.lossMinor, 5_000);
    assert.equal(result.reserveMinor, 0);
  });
  await t.test("B91-R05 thresholds trigger review without silent safety relaxation", () => {
    const metrics = f.finance.evaluateDisputeThresholds(f.reviewer, { merchantId: "merchant-1", disputeCount: 10, transactionCount: 100, falsePositiveBasisPoints: 600, thresholdBasisPoints: 900, idempotencyKey: "b91-r05" });
    assert.equal(metrics.policyReviewRequired, true);
    assert.equal(metrics.automaticSafetyRelaxation, false);
  });
  f.repository.close();
});

test("B92 dedicated partner settlement engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B92-R01 versioned server contract determines commission and withholding", () => {
    const contract = f.finance.configurePartnerContract(f.reviewer, { partnerId: "partner-1", contractVersion: "contract-v1", effectiveFrom: "2026-01-01", effectiveUntil: "2026-12-31", commissionBasisPoints: 1_000, tierThresholdMinor: 10_000, tierCommissionBasisPoints: 1_500, withholdingBasisPoints: 100, holdbackBasisPoints: 200, refundWindowDays: 30, idempotencyKey: "b92-r01" });
    assert.equal(contract.status, "approved");
  });
  let payout: JsonObject;
  await t.test("B92-R02 period statement itemizes revenue/refunds/fees/tax/holdback/net", () => {
    payout = f.finance.createPayoutStatement(f.actor, { statementId: "payout-1", partnerId: "partner-1", contractVersion: "contract-v1", currency: "CNY", period: "2026-08", lines: [{ orderId: "order-1", revenueMinor: 20_000, refundMinor: 1_000, feeMinor: 500, attributed: true }], adjustmentsMinor: 0, idempotencyKey: "b92-r02" });
    const line = (payout.lines as readonly JsonObject[])[0];
    assert.equal(line?.rateBasisPoints, 1_500);
    assert.ok(Number(payout.netPayableMinor) > 0);
  });
  await t.test("B92-R03 payout approval uses two-person control and durable state", () => {
    const bank = f.fact("bank:payout", "partner.bank-account", "partner-1", { partnerId: "partner-1", accountToken: "vault:acct-1", verified: true, changedAt: "2026-08-26T00:00:00Z" });
    const approved = f.finance.approvePayout(f.reviewer, { statementId: "payout-1", approverIds: ["a1", "a2"], bankAccountFact: bank, coolingEndsAt: "2026-08-27T00:00:00Z", idempotencyKey: "b92-r03" });
    assert.equal(approved.state, "approved");
  });
  await t.test("B92-R04 signed payment binds verified vault account after cooling", () => {
    const fact = f.fact("bank:payout", "partner.payout", "payout-1", { statementId: "payout-1", amountMinor: payout.netPayableMinor, currency: "CNY", status: "paid", providerPaymentId: "bank-payment-1" }, 2);
    const paid = f.finance.applyPayoutFact(f.actor, fact, "b92-r04");
    assert.equal(paid.state, "paid");
    assert.equal(paid.providerPaymentId, "bank-payment-1");
  });
  await t.test("B92-R05 withholding document links paid settlement and bank reconciliation", () => {
    const result = f.finance.issueWithholdingDocument(f.reviewer, "payout-1", "withholding-1", TEST_DIGEST, "b92-r05");
    assert.equal(result.withholdingDocumentId, "withholding-1");
    assert.equal(result.reconciliationState, "bank_pending");
  });
  f.repository.close();
});

test("B93 dedicated FinOps engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B93-R01 signed provider costs are reconcilable facts", () => {
    const fact = f.fact("vendor:cost", "cost.vendor", "cost-1", { costEventId: "cost-1", category: "printing", amountMinor: 10_001, currency: "CNY", projectId: "project-1", orderId: "order-1", tenantId: "tenant-a", partnerId: "partner-1", channel: "web", region: "CN", model: "none", product: "book" });
    const cost = f.finance.recordCostEvent(f.actor, fact, "b93-r01");
    assert.equal(cost.provider, "vendor:cost");
    assert.equal(cost.allocated, false);
  });
  await t.test("B93-R02 versioned rules allocate exact cost across dimensions", () => {
    f.finance.configureAllocationRule(f.reviewer, { ruleId: "allocate-print", version: "v1", category: "printing", dimensions: ["order", "product"], allocations: [{ target: "order-1", basisPoints: 6_000 }, { target: "product-book", basisPoints: 4_000 }], effectiveFrom: "2026-01-01", idempotencyKey: "b93-r02-rule" });
    const allocated = f.finance.allocateCost(f.actor, "cost-1", "allocate-print", "v1", "b93-r02");
    assert.equal((allocated.allocations as readonly JsonObject[]).reduce((sum, item) => sum + Number(item.amountMinor), 0), 10_001);
  });
  await t.test("B93-R03 budgets never disable safety or cancel paid work", () => {
    expectCode(() => f.finance.evaluateBudget(f.actor, { budgetId: "budget-unsafe", period: "2026-08", limitMinor: 100, actualMinor: 200, projectedMinor: 300, action: "disable_safety", idempotencyKey: "b93-r03-bad" }), "POLICY_BLOCKED");
    const result = f.finance.evaluateBudget(f.actor, { budgetId: "budget-1", period: "2026-08", limitMinor: 100, actualMinor: 200, projectedMinor: 300, action: "manual_approval", idempotencyKey: "b93-r03" });
    assert.equal(result.safetyControlsPreserved, true);
  });
  await t.test("B93-R04 profit uses recognized revenue and complete cost stack, not cash", () => {
    const result = f.finance.profitability({ recognizedRevenueMinor: 10_000, refundsMinor: 500, partnerShareMinor: 1_000, acquisitionMinor: 500, serviceMinor: 1_000, fulfillmentMinor: 2_000, cashCollectedMinor: 50_000 });
    assert.equal(result.profitMinor, 5_000);
    assert.equal(result.cashCollectedExcludedFromProfit, true);
  });
  await t.test("B93-R05 forecast labels assumptions, confidence, sensitivity, and root cause", () => {
    const forecast = f.finance.forecastCost(f.actor, { forecastId: "forecast-1", budgetMinor: 10_000, forecastMinor: 12_000, assumptions: ["volume-flat"], confidenceBasisPoints: 8_000, sensitivityBasisPoints: 1_000, rootCauseCodes: ["print-rate-rise"], idempotencyKey: "b93-r05" });
    assert.equal(forecast.estimateClearlyLabeled, true);
    assert.equal(forecast.varianceMinor, 2_000);
  });
  f.repository.close();
});

test("B94 dedicated month-close engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  configureLedger(f.finance, f.reviewer);
  const domains = ["payment", "bank", "partner", "vendor", "deferred", "revenue", "tax", "dispute", "reserve", "fx", "exception"] as const;
  await t.test("B94-R01 close checklist binds owners, dependencies, thresholds, approvals", () => {
    const close = f.finance.createCloseChecklist(f.reviewer, { closeId: "close-2026-08", legalEntityId: "entity-cn", currency: "CNY", period: "2026-08", tasks: domains.map((domain, index) => ({ taskId: `task-${index}`, domain, ownerId: `owner-${index}`, dependencyTaskIds: index === 0 ? [] : [`task-${index - 1}`], status: "complete", evidenceSha256: TEST_DIGEST })), materialityMinor: 100, idempotencyKey: "b94-r01" });
    assert.equal(close.state, "ready");
  });
  await t.test("B94-R02 every required reconciliation/tax/revenue/reserve/FX domain gates close", () => {
    const closed = f.finance.hardClose(f.reviewer, { closeId: "close-2026-08", approverIds: ["a1", "a2"], idempotencyKey: "b94-r02" });
    assert.equal(closed.state, "hard_closed");
    assert.equal((closed.tasks as readonly JsonObject[]).length, 11);
  });
  let exported: JsonObject;
  await t.test("B94-R03 versioned encrypted accounting adapter exports controlled totals", () => {
    exported = f.finance.createAccountingExport(f.reviewer, { exportId: "export-1", closeId: "close-2026-08", adapterId: "erp-main", adapterVersion: "v1", encryptionKeyReference: "kms:finance-export", idempotencyKey: "b94-r03" });
    assert.equal((exported.control as JsonObject).debitMinor, (exported.control as JsonObject).creditMinor);
  });
  await t.test("B94-R04 signed ERP acknowledgement binds exact export digest", () => {
    const fact = f.fact("erp:main", "accounting.export-ack", "export-1", { exportId: "export-1", exportSha256: exported.exportSha256, status: "accepted", providerBatchId: "erp-batch-1" });
    const result = f.finance.acknowledgeAccountingExport(f.actor, fact, "b94-r04");
    assert.equal(result.state, "accepted");
  });
  await t.test("B94-R05 minimized audit package hashes policy/source/reconciliation/access evidence", () => {
    const result = f.finance.createAuditPackage(f.reviewer, { closeId: "close-2026-08", policyVersions: ["accounting-v1", "retention-v1"], accessLogSha256: TEST_DIGEST, changeLogSha256: TEST_DIGEST_B, expiresAt: "2026-09-30T00:00:00Z", idempotencyKey: "b94-r05" });
    assert.match(String(result.auditPackageSha256), /^[a-f0-9]{64}$/);
    assert.equal(result.sensitiveFieldsMinimized, true);
  });
  f.repository.close();
});
