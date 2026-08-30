import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  rejectClientAssertions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-data-intelligence-platform";

function sha256(input: JsonObject, field: string): string {
  const value = requiredString(input, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function providerEnvironment(input: JsonObject): "test" | "sandbox" | "staging" | "production" {
  return assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["test", "sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
}

function eventSchema(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const schemaId = requiredString(input, "schemaId");
  const eventName = requiredString(input, "eventName");
  const version = requiredString(input, "version");
  const producer = requiredString(input, "producer");
  const requiredFields = stringList(input, "requiredFields", { min: 3, unique: true });
  const dataClasses = stringList(input, "dataClasses", { min: 1, unique: true });
  const consentPurpose = requiredString(input, "consentPurpose");
  const dedupeKey = requiredString(input, "dedupeKey");
  const retentionDays = requireInteger(requiredNumber(input, "retentionDays", 1), "retentionDays", 1, 3_650);
  const serverAuthoritative = requiredBoolean(input, "serverAuthoritative");
  const forbiddenFields = stringList(input, "forbiddenFields", { min: 4, unique: true });
  for (const field of ["raw_media", "face_features", "private_dialogue", "payment_credential"]) {
    if (!forbiddenFields.includes(field)) throw new DomainError("VALIDATION_FAILED", `forbiddenFields must include ${field}`);
  }
  if (eventName.includes("payment") && !serverAuthoritative) {
    throw new DomainError("VALIDATION_FAILED", "payment facts must be produced by a server-authoritative source");
  }
  return {
    schemaId,
    eventName,
    version,
    producer,
    requiredFields,
    dataClasses,
    consentPurpose,
    dedupeKey,
    retentionDays,
    serverAuthoritative,
    forbiddenFields,
  };
}

function warehousePipeline(input: JsonObject): JsonObject {
  const pipelineId = requiredString(input, "pipelineId");
  const source = requiredString(input, "source");
  const layers = stringList(input, "layers", { min: 4, unique: true });
  const watermark = requiredString(input, "watermark");
  const primaryKeys = stringList(input, "primaryKeys", { min: 1, unique: true });
  const semanticMetrics = stringList(input, "semanticMetrics", { min: 3, unique: true });
  const controls = stringList(input, "controls", { min: 3, unique: true });
  const replaySideEffectsDisabled = requireTrue(requiredBoolean(input, "replaySideEffectsDisabled"), "replaySideEffectsDisabled");
  const deletionMarkersPreserved = requireTrue(requiredBoolean(input, "deletionMarkersPreserved"), "deletionMarkersPreserved");
  for (const layer of ["raw", "staging", "core", "mart"]) {
    if (!layers.includes(layer)) throw new DomainError("VALIDATION_FAILED", `layers must include ${layer}`);
  }
  for (const control of ["row_count", "amount_total", "freshness"]) {
    if (!controls.includes(control)) throw new DomainError("VALIDATION_FAILED", `controls must include ${control}`);
  }
  return {
    pipelineId,
    source,
    layers,
    watermark,
    primaryKeys,
    semanticMetrics,
    controls,
    replaySideEffectsDisabled,
    deletionMarkersPreserved,
  };
}

function dashboard(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const dashboardId = requiredString(input, "dashboardId");
  const audienceRole = requiredString(input, "audienceRole");
  const metrics = stringList(input, "metrics", { min: 2, unique: true });
  const definitionsVersion = requiredString(input, "definitionsVersion");
  const rowLevelTenantFilter = requireTrue(requiredBoolean(input, "rowLevelTenantFilter"), "rowLevelTenantFilter");
  const columnMasking = requireTrue(requiredBoolean(input, "columnMasking"), "columnMasking");
  const freshnessMinutes = requireInteger(requiredNumber(input, "freshnessMinutes", 1), "freshnessMinutes", 1, 10_080);
  const drilldownDataClasses = stringList(input, "drilldownDataClasses", { unique: true });
  if (drilldownDataClasses.some((value) => ["raw_media", "private_dialogue", "face_features"].includes(value))) {
    throw new DomainError("AUTH_FORBIDDEN", "dashboard drilldown exposes prohibited sensitive content");
  }
  return {
    dashboardId,
    audienceRole,
    metrics,
    definitionsVersion,
    rowLevelTenantFilter,
    columnMasking,
    freshnessMinutes,
    drilldownDataClasses,
  };
}

function attributionModel(input: JsonObject): JsonObject {
  const modelId = requiredString(input, "modelId");
  const method = assertKnownState(requiredString(input, "method"), ["first_touch", "last_touch", "multi_touch", "incremental"] as const, "method");
  const windowDays = requireInteger(requiredNumber(input, "windowDays", 1), "windowDays", 1, 365);
  const cohortUnit = assertKnownState(requiredString(input, "cohortUnit"), ["account", "household", "tenant"] as const, "cohortUnit");
  const costComponents = stringList(input, "costComponents", { min: 5, unique: true });
  const consentMissingFlagged = requireTrue(requiredBoolean(input, "consentMissingFlagged"), "consentMissingFlagged");
  const refundsIncluded = requireTrue(requiredBoolean(input, "refundsIncluded"), "refundsIncluded");
  const uncertaintyDocumented = requireTrue(requiredBoolean(input, "uncertaintyDocumented"), "uncertaintyDocumented");
  for (const component of ["refund", "partner_share", "ai", "support", "fulfillment"]) {
    if (!costComponents.includes(component)) throw new DomainError("VALIDATION_FAILED", `costComponents must include ${component}`);
  }
  return { modelId, method, windowDays, cohortUnit, costComponents, consentMissingFlagged, refundsIncluded, uncertaintyDocumented };
}

function unitEconomics(input: JsonObject): JsonObject {
  const modelId = requiredString(input, "modelId");
  const grain = assertKnownState(requiredString(input, "grain"), ["order", "project", "partner", "channel"] as const, "grain");
  const currency = requiredString(input, "currency").toUpperCase();
  const revenueMinor = requireInteger(requiredNumber(input, "revenueMinor", 0), "revenueMinor", 0);
  const refundMinor = requireInteger(requiredNumber(input, "refundMinor", 0), "refundMinor", 0);
  const costs = objectValue(input, "costs");
  const costComponents = stringList(input, "costComponents", { min: 7, unique: true });
  const ledgerReconciled = requireTrue(requiredBoolean(input, "ledgerReconciled"), "ledgerReconciled");
  const assumptionsSeparated = requireTrue(requiredBoolean(input, "assumptionsSeparated"), "assumptionsSeparated");
  if (!/^[A-Z]{3}$/.test(currency) || refundMinor > revenueMinor) throw new DomainError("VALIDATION_FAILED", "unit economics money values are invalid");
  for (const component of ["ai_retry", "storage", "payment", "message", "fulfillment", "support", "partner_share"]) {
    if (!costComponents.includes(component)) throw new DomainError("VALIDATION_FAILED", `costComponents must include ${component}`);
  }
  return {
    modelId,
    grain,
    currency,
    revenueMinor,
    refundMinor,
    costs,
    costComponents,
    ledgerReconciled,
    assumptionsSeparated,
  };
}

function experiment(input: JsonObject): JsonObject {
  const experimentId = requiredString(input, "experimentId");
  const hypothesis = requiredString(input, "hypothesis");
  const population = requiredString(input, "population");
  const assignmentUnit = assertKnownState(requiredString(input, "assignmentUnit"), ["account", "household", "tenant", "device"] as const, "assignmentUnit");
  const variants = stringList(input, "variants", { min: 2, unique: true });
  const primaryMetric = requiredString(input, "primaryMetric");
  const guardrails = stringList(input, "guardrails", { min: 6, unique: true });
  const sampleSize = requireInteger(requiredNumber(input, "sampleSize", 1), "sampleSize", 1);
  const stopRule = requiredString(input, "stopRule");
  const deterministicAssignment = requireTrue(requiredBoolean(input, "deterministicAssignment"), "deterministicAssignment");
  const recordsActualExposure = requireTrue(requiredBoolean(input, "recordsActualExposure"), "recordsActualExposure");
  const approvalIds = stringList(input, "approvalIds", { min: 2, unique: true });
  for (const guardrail of ["consent", "ai_label", "child_safety", "payment_truth", "deletion", "high_impact_ban"]) {
    if (!guardrails.includes(guardrail)) throw new DomainError("VALIDATION_FAILED", `non-waivable experiment guardrail missing: ${guardrail}`);
  }
  if (variants.some((variant) => /disable[-_](consent|ai|child|deletion)|fake[-_]price/i.test(variant))) {
    throw new DomainError("VALIDATION_FAILED", "experiment variant attempts to alter a non-waivable safeguard");
  }
  return {
    experimentId,
    hypothesis,
    population,
    assignmentUnit,
    variants,
    primaryMetric,
    guardrails,
    sampleSize,
    stopRule,
    deterministicAssignment,
    recordsActualExposure,
    approvalIds,
  };
}

function dataGovernance(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const assetId = requiredString(input, "assetId");
  const ownerId = requiredString(input, "ownerId");
  const classification = assertKnownState(requiredString(input, "classification"), ["public", "internal", "confidential", "restricted"] as const, "classification");
  const lineageUpstream = stringList(input, "lineageUpstream", { min: 1, unique: true });
  const lineageDownstream = stringList(input, "lineageDownstream", { min: 1, unique: true });
  const qualityRules = stringList(input, "qualityRules", { min: 4, unique: true });
  const deletionTargets = stringList(input, "deletionTargets", { min: 5, unique: true });
  const accessAuditEnabled = requireTrue(requiredBoolean(input, "accessAuditEnabled"), "accessAuditEnabled");
  const exportControlled = requireTrue(requiredBoolean(input, "exportControlled"), "exportControlled");
  for (const target of ["business_store", "warehouse", "cache", "export", "connector"]) {
    if (!deletionTargets.includes(target)) throw new DomainError("VALIDATION_FAILED", `deletionTargets must include ${target}`);
  }
  return {
    assetId,
    ownerId,
    classification,
    lineageUpstream,
    lineageDownstream,
    qualityRules,
    deletionTargets,
    accessAuditEnabled,
    exportControlled,
  };
}

function modelEvaluation(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["criticalFailures", "rollbackReady", "rawMediaRetained", "evaluationPassed"]);
  const evaluationId = requiredString(input, "evaluationId");
  const modelVersion = requiredString(input, "modelVersion");
  const promptVersion = requiredString(input, "promptVersion");
  const datasetId = requiredString(input, "datasetId");
  const datasetAuthorization = assertKnownState(requiredString(input, "datasetAuthorization"), ["synthetic", "licensed", "consented"] as const, "datasetAuthorization");
  const cohorts = stringList(input, "cohorts", { min: 4, unique: true });
  const metrics = stringList(input, "metrics", { min: 6, unique: true });
  const evaluationProviderId = requiredString(input, "evaluationProviderId");
  const environment = providerEnvironment(input);
  const evaluationReportSha256 = sha256(input, "evaluationReportSha256");
  const reportSchemaVersion = requiredString(input, "reportSchemaVersion");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (!cohorts.includes("minor") || !metrics.includes("safety") || !metrics.includes("fairness")) {
    throw new DomainError("VALIDATION_FAILED", "model evaluation must cover minors, safety, and fairness");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B118",
    operation: "recordModelEvaluation",
    kind: "model-evaluation-report",
    provider: `model-evaluator:${evaluationProviderId}`,
    artifactSha256: evaluationReportSha256,
    environment,
    subjectId: evaluationId,
  });
  return {
    evaluationId,
    modelVersion,
    promptVersion,
    datasetId,
    datasetAuthorization,
    cohorts,
    metrics,
    evaluationProviderId,
    providerEnvironment: environment,
    evaluationReportSha256,
    reportSchemaVersion,
    externalEvidenceIds,
    evidenceScope,
    decisionState: environment === "production" ? "verified" : "simulation_only",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B111", SKILL, "publishEventSchema", eventSchema, {
    permission: "analytics.schema.publish",
    mode: "resource",
  }),
  defineCapability("B112", SKILL, "registerWarehousePipeline", warehousePipeline, {
    permission: "data.pipeline.manage",
    mode: "resource",
  }),
  defineCapability("B113", SKILL, "publishGovernedDashboard", dashboard, {
    permission: "analytics.dashboard.publish",
    mode: "resource",
  }),
  defineCapability("B114", SKILL, "publishAttributionModel", attributionModel, {
    permission: "analytics.attribution.publish",
    mode: "resource",
  }),
  defineCapability("B115", SKILL, "publishUnitEconomicsModel", unitEconomics, {
    permission: "analytics.unit-economics.publish",
    mode: "resource",
  }),
  defineCapability("B116", SKILL, "registerGuardedExperiment", experiment, {
    permission: "experiment.manage",
    mode: "resource",
  }),
  defineCapability("B117", SKILL, "registerGovernedDataAsset", dataGovernance, {
    permission: "data.catalog.manage",
    mode: "resource",
  }),
  defineCapability("B118", SKILL, "recordModelEvaluation", modelEvaluation, {
    permission: "model.evaluation.record",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "evaluationReportSha256",
    mode: "attestation",
  }),
];

export function registerBuildingDataIntelligencePlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingDataIntelligencePlatformCoverage = definitions.length;
