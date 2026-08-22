import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject, JsonValue } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  rejectClientAssertions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-finance-tax-operations";

function assertFinanceStepUp(invocation: CapabilityInvocation): void {
  if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "financial writes require step-up authentication");
}

function currency(input: JsonObject): string {
  const value = requiredString(input, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) throw new DomainError("VALIDATION_FAILED", "currency must be an ISO-4217 code");
  return value;
}

function amount(input: JsonObject, field = "amountMinor", minimum = 1): number {
  return requireInteger(requiredNumber(input, field, minimum), field, minimum);
}

function sha256(input: JsonObject, field: string): string {
  const value = requiredString(input, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function providerEnvironment(input: JsonObject): "sandbox" | "production" {
  return assertKnownState(requiredString(input, "providerEnvironment"), ["sandbox", "production"] as const, "providerEnvironment");
}

function objectList(input: JsonObject, field: string, minimum = 1): JsonObject[] {
  const value = input[field];
  if (!Array.isArray(value) || value.length < minimum) throw new DomainError("VALIDATION_FAILED", `${field} must be a non-empty object array`);
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainError("VALIDATION_FAILED", `${field} contains a non-object entry`);
    }
    return entry as JsonObject;
  });
}

function lineString(line: JsonObject, field: string): string {
  const value: JsonValue | undefined = line[field];
  if (typeof value !== "string" || value.trim() === "") throw new DomainError("VALIDATION_FAILED", `${field} is required on every line`);
  return value;
}

function lineAmount(line: JsonObject, field: string): number {
  const value = line[field];
  if (typeof value !== "number") throw new DomainError("VALIDATION_FAILED", `${field} must be numeric on every line`);
  return requireInteger(value, field, 1);
}

function journalEntry(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertFinanceStepUp(invocation);
  const journalId = requiredString(input, "journalId");
  const legalEntityId = requiredString(input, "legalEntityId");
  const sourceType = requiredString(input, "sourceType");
  const sourceId = requiredString(input, "sourceId");
  const entryCurrency = currency(input);
  const period = requiredString(input, "period");
  const periodState = assertKnownState(requiredString(input, "periodState"), ["open"] as const, "periodState");
  const rawLines = objectList(input, "lines", 2);
  let debitMinor = 0;
  let creditMinor = 0;
  const lines = rawLines.map((line) => {
    const accountCode = lineString(line, "accountCode");
    const direction = assertKnownState(lineString(line, "direction"), ["debit", "credit"] as const, "direction");
    const amountMinor = lineAmount(line, "amountMinor");
    const lineCurrency = lineString(line, "currency").toUpperCase();
    if (lineCurrency !== entryCurrency) throw new DomainError("LEDGER_UNBALANCED", "cross-currency journal lines are not allowed");
    if (direction === "debit") debitMinor += amountMinor;
    else creditMinor += amountMinor;
    return { accountCode, direction, amountMinor, currency: lineCurrency };
  });
  if (debitMinor !== creditMinor) throw new DomainError("LEDGER_UNBALANCED", "journal debits and credits must balance");
  return {
    journalId,
    legalEntityId,
    sourceType,
    sourceId,
    currency: entryCurrency,
    period,
    periodState,
    lines,
    debitMinor,
    creditMinor,
    immutable: true,
  };
}

function reconciliation(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertFinanceStepUp(invocation);
  const reconciliationId = requiredString(input, "reconciliationId");
  const statementId = requiredString(input, "statementId");
  const statementDigest = requiredString(input, "statementDigest");
  const sourceCurrency = currency(input);
  const statementTotalMinor = amount(input, "statementTotalMinor", 0);
  const matchedTotalMinor = amount(input, "matchedTotalMinor", 0);
  const exceptionTotalMinor = amount(input, "exceptionTotalMinor", 0);
  const duplicateImportChecked = requireTrue(requiredBoolean(input, "duplicateImportChecked"), "duplicateImportChecked");
  const crossCurrencyMatching = requiredBoolean(input, "crossCurrencyMatching");
  if (matchedTotalMinor + exceptionTotalMinor !== statementTotalMinor || crossCurrencyMatching) {
    throw new DomainError("VALIDATION_FAILED", "reconciliation control totals do not balance or cross-currency matching was attempted");
  }
  return {
    reconciliationId,
    statementId,
    statementDigest,
    currency: sourceCurrency,
    statementTotalMinor,
    matchedTotalMinor,
    exceptionTotalMinor,
    duplicateImportChecked,
    crossCurrencyMatching,
  };
}

function invoice(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, [
    "providerDeduplicated",
    "refundRequiresCreditNote",
    "taxRequestArtifactSha256",
    "providerRequestId",
    "externalEvidenceIds",
  ]);
  assertFinanceStepUp(invocation);
  const invoiceId = requiredString(input, "invoiceId");
  const legalEntityId = requiredString(input, "legalEntityId");
  const providerId = requiredString(input, "providerId");
  const providerEnvironmentValue = providerEnvironment(input);
  const invoiceType = assertKnownState(requiredString(input, "invoiceType"), ["receipt", "invoice", "fapiao", "credit_note"] as const, "invoiceType");
  const taxProfileVersion = requiredString(input, "taxProfileVersion");
  const sequenceScope = requiredString(input, "sequenceScope");
  const amountMinor = amount(input);
  const invoiceCurrency = currency(input);
  const creditNotePolicyVersion = requiredString(input, "creditNotePolicyVersion");
  return {
    invoiceId,
    legalEntityId,
    providerId,
    providerEnvironment: providerEnvironmentValue,
    invoiceType,
    taxProfileVersion,
    sequenceScope,
    amountMinor,
    currency: invoiceCurrency,
    creditNotePolicyVersion,
    commandState: "requested",
  };
}

function revenueSchedule(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertFinanceStepUp(invocation);
  const scheduleId = requiredString(input, "scheduleId");
  const contractId = requiredString(input, "contractId");
  const obligationType = assertKnownState(
    requiredString(input, "obligationType"),
    ["digital", "subscription", "credits", "gift", "physical", "partner"] as const,
    "obligationType",
  );
  const totalMinor = amount(input, "totalMinor", 1);
  const scheduleCurrency = currency(input);
  const rawMilestones = objectList(input, "milestones", 1);
  let scheduledMinor = 0;
  const milestones = rawMilestones.map((milestone) => {
    const recognitionDate = assertISODate(lineString(milestone, "recognitionDate"), "recognitionDate");
    const amountMinor = lineAmount(milestone, "amountMinor");
    scheduledMinor += amountMinor;
    return { recognitionDate, amountMinor };
  });
  const historicalScheduleImmutable = requireTrue(requiredBoolean(input, "historicalScheduleImmutable"), "historicalScheduleImmutable");
  if (scheduledMinor !== totalMinor) throw new DomainError("VALIDATION_FAILED", "recognition milestones must equal the contract total");
  return {
    scheduleId,
    contractId,
    obligationType,
    totalMinor,
    currency: scheduleCurrency,
    milestones,
    scheduledMinor,
    historicalScheduleImmutable,
  };
}

function dispute(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["alreadyRefunded"]);
  assertFinanceStepUp(invocation);
  const disputeId = requiredString(input, "disputeId");
  const providerCaseId = requiredString(input, "providerCaseId");
  const providerId = requiredString(input, "providerId");
  const providerEnvironmentValue = providerEnvironment(input);
  const disputeArtifactSha256 = sha256(input, "disputeArtifactSha256");
  const action = assertKnownState(requiredString(input, "action"), ["accept", "defend", "write_off"] as const, "action");
  const amountMinor = amount(input);
  const disputeCurrency = currency(input);
  const responseDueAt = assertISODate(requiredString(input, "responseDueAt"), "responseDueAt");
  const evidenceIds = stringList(input, "evidenceIds", { min: 1, unique: true });
  const reserveEntryId = requiredString(input, "reserveEntryId");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (action === "defend" && Date.parse(responseDueAt) <= Date.now()) {
    throw new DomainError("VALIDATION_FAILED", "expired disputes cannot be defended");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B91",
    operation: "recordDisputeDecision",
    kind: "payment-dispute",
    provider: `payment:${providerId}`,
    artifactSha256: disputeArtifactSha256,
    environment: providerEnvironmentValue,
    subjectId: disputeId,
  });
  return {
    disputeId,
    providerCaseId,
    providerId,
    providerEnvironment: providerEnvironmentValue,
    disputeArtifactSha256,
    action,
    amountMinor,
    currency: disputeCurrency,
    responseDueAt,
    evidenceIds,
    reserveEntryId,
    externalEvidenceIds,
    evidenceScope,
  };
}

function payout(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["refundWindowClosed"]);
  assertFinanceStepUp(invocation);
  const payoutId = requiredString(input, "payoutId");
  const partnerId = requiredString(input, "partnerId");
  const providerId = requiredString(input, "providerId");
  const providerEnvironmentValue = providerEnvironment(input);
  const payoutArtifactSha256 = sha256(input, "payoutArtifactSha256");
  const statementId = requiredString(input, "statementId");
  const accountReference = requiredString(input, "accountReference");
  const amountMinor = amount(input);
  const payoutCurrency = currency(input);
  const refundReconciliationId = requiredString(input, "refundReconciliationId");
  const approvalIds = stringList(input, "approvalIds", { min: 2, unique: true });
  const withholdingDocumentId = requiredString(input, "withholdingDocumentId");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (/\d{8,}/.test(accountReference)) throw new DomainError("VALIDATION_FAILED", "accountReference must be tokenized, not raw bank details");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B92",
    operation: "approvePartnerPayout",
    kind: "partner-payout",
    provider: `payment:${providerId}`,
    artifactSha256: payoutArtifactSha256,
    environment: providerEnvironmentValue,
    subjectId: payoutId,
  });
  return {
    payoutId,
    partnerId,
    providerId,
    providerEnvironment: providerEnvironmentValue,
    payoutArtifactSha256,
    statementId,
    accountReference,
    amountMinor,
    currency: payoutCurrency,
    refundReconciliationId,
    approvalIds,
    withholdingDocumentId,
    externalEvidenceIds,
    evidenceScope,
  };
}

function costAllocation(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertFinanceStepUp(invocation);
  const allocationId = requiredString(input, "allocationId");
  const costEventId = requiredString(input, "costEventId");
  const costType = assertKnownState(
    requiredString(input, "costType"),
    ["ai", "storage", "bandwidth", "message", "payment", "fulfillment", "support", "infrastructure"] as const,
    "costType",
  );
  const amountMinor = amount(input);
  const costCurrency = currency(input);
  const allocationBasis = requiredString(input, "allocationBasis");
  const allocationPercent = requiredNumber(input, "allocationPercent", 0);
  const cacheHitDeduplicated = requireTrue(requiredBoolean(input, "cacheHitDeduplicated"), "cacheHitDeduplicated");
  const paidOrdersProtected = requireTrue(requiredBoolean(input, "paidOrdersProtected"), "paidOrdersProtected");
  if (allocationPercent <= 0 || allocationPercent > 100) throw new DomainError("VALIDATION_FAILED", "allocationPercent must be in (0,100]");
  return {
    allocationId,
    costEventId,
    costType,
    amountMinor,
    currency: costCurrency,
    allocationBasis,
    allocationPercent,
    cacheHitDeduplicated,
    paidOrdersProtected,
  };
}

function closePeriod(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertFinanceStepUp(invocation);
  const closeId = requiredString(input, "closeId");
  const period = requiredString(input, "period");
  const legalEntityId = requiredString(input, "legalEntityId");
  const erpProviderId = requiredString(input, "erpProviderId");
  const providerEnvironmentValue = providerEnvironment(input);
  const closeArtifactSha256 = sha256(input, "closeArtifactSha256");
  const trialBalanceMinor = amount(input, "trialBalanceMinor", 0);
  const exportControlTotalMinor = amount(input, "exportControlTotalMinor", 0);
  const checklist = stringList(input, "checklist", { min: 4, unique: true });
  const approvalIds = stringList(input, "approvalIds", { min: 2, unique: true });
  const exportIdempotencyReference = requiredString(input, "exportIdempotencyReference");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (trialBalanceMinor !== exportControlTotalMinor) throw new DomainError("LEDGER_UNBALANCED", "ERP export control total differs from trial balance");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B94",
    operation: "approveMonthEndClose",
    kind: "financial-close-export",
    provider: `erp:${erpProviderId}`,
    artifactSha256: closeArtifactSha256,
    environment: providerEnvironmentValue,
    subjectId: closeId,
  });
  return {
    closeId,
    period,
    legalEntityId,
    erpProviderId,
    providerEnvironment: providerEnvironmentValue,
    closeArtifactSha256,
    trialBalanceMinor,
    exportControlTotalMinor,
    checklist,
    approvalIds,
    exportIdempotencyReference,
    externalEvidenceIds,
    evidenceScope,
    state: "ready_to_close",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B87", SKILL, "postBalancedJournal", journalEntry, {
    permission: "ledger:post",
    mode: "ledger-post",
  }),
  defineCapability("B88", SKILL, "recordReconciliation", reconciliation, { permission: "finance.reconcile", mode: "resource" }),
  defineCapability("B89", SKILL, "requestTaxDocument", invoice, {
    permission: "finance.invoice.request",
    mode: "external-command",
    collection: "finance.tax-document-commands",
    recordIdField: "invoiceId",
  }),
  defineCapability("B90", SKILL, "createRevenueSchedule", revenueSchedule, { permission: "finance.revenue-schedule.manage", mode: "resource" }),
  defineCapability("B91", SKILL, "recordDisputeDecision", dispute, {
    permission: "finance.dispute.manage",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
  defineCapability("B92", SKILL, "approvePartnerPayout", payout, {
    permission: "finance.payout.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
  defineCapability("B93", SKILL, "recordCostAllocation", costAllocation, { permission: "finance.cost.allocate", mode: "resource" }),
  defineCapability("B94", SKILL, "approveMonthEndClose", closePeriod, {
    permission: "finance.close.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
];

export function registerBuildingFinanceTaxOperationsCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingFinanceTaxOperationsCoverage = definitions.length;
