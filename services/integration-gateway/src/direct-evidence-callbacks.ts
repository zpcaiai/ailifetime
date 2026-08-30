import {
  canonicalJson,
  decisionRequestSha256,
  type JsonObject,
} from "@ltm/core";
import {
  ProductionIntegrationError,
  SignedPartnerWebhookIntegration,
  assertCapabilityEvidenceBinding,
  parseJsonObject,
  parseOperationalReport,
  requiredString,
  type CapabilityEvidenceBinding,
  type CapabilityEvidenceBindingTemplate,
  type EvidenceArtifactStore,
  type EvidenceAttestor,
  type EvidenceEnvironment,
  type OperationalReportEvidenceBinding,
  type PartnerWebhookSignatureScheme,
  type ReplayStore,
  type SecretReference,
  type SecretResolver,
} from "@ltm/providers";
import type { GatewayCallbackHandler } from "./gateway.js";

const POLICY_VERSION = "ltm.direct-evidence-authorities.v1";
const PAYLOAD_VERSION = "ltm.direct-evidence-callback.v1";
const TOP_LEVEL_KEYS = ["version", "authorities"] as const;
const AUTHORITY_KEYS = [
  "routeId",
  "provider",
  "signatureScheme",
  "verificationKeyReference",
  "maximumClockSkewSeconds",
  "maximumBodyBytes",
  "retentionClass",
] as const;
const DECISION_PAYLOAD_KEYS = [
  "version", "routeId", "provider", "evidenceEventId", "subjectId", "providerOccurredAt",
  "decision", "decisionReference", "claims", "decisionRequest", "decisionRequestSha256",
] as const;
const REPORT_PAYLOAD_KEYS = [
  "version", "routeId", "provider", "evidenceEventId", "report", "decisionRequest", "decisionRequestSha256",
] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JSON_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_CLAIM_FIELDS = new Set([
  "tenant", "tenantId", "batchId", "operation", "kind", "provider", "environment", "scope",
  "evidenceId", "artifactSha256", "subjectId", "decision", "outcome", "approved", "passed",
  "success", "isApproved", "isPassed", "isSuccessful",
]);

type DirectEvidenceDecision =
  | "approved"
  | "passed"
  | "verified"
  | "published"
  | "certified";

interface ProviderRule {
  readonly exact?: readonly string[];
  readonly prefixes?: readonly string[];
}

interface DecisionRouteDefinition {
  readonly artifactType: "decision";
  readonly routeId: string;
  readonly batchId: `B${string}`;
  readonly operation: string;
  readonly evidenceKind: string;
  readonly providerRule: ProviderRule;
  readonly expectedDecision: DirectEvidenceDecision;
}

interface OperationalReportRouteDefinition {
  readonly artifactType: "operational-report";
  readonly routeId: string;
  readonly batchId: "B56" | "B118" | "B119" | "B121" | "B122";
  readonly operation: string;
  readonly evidenceKind: string;
  readonly providerRule: ProviderRule;
  readonly reportSubjectField: string;
}

export type DirectEvidenceRouteDefinition = DecisionRouteDefinition | OperationalReportRouteDefinition;

const prefix = (...prefixes: string[]): ProviderRule => ({ prefixes });
const exact = (...values: string[]): ProviderRule => ({ exact: values });

/**
 * Every direct-invocation evidence gate except B127. B127 is intentionally
 * owned by the independent release-control verifier and cannot be registered
 * through this general partner boundary.
 */
export const DIRECT_EVIDENCE_CALLBACK_ROUTES: readonly DirectEvidenceRouteDefinition[] = Object.freeze([
  decision("b37-education-assurance", "B37", "configureEducationExperience", "education-assurance", prefix("education-assurance:"), "approved"),
  decision("b44-security-baseline", "B44", "approveSecurityBaseline", "security-baseline", prefix("security-auditor:"), "approved"),
  decision("b46-recovery-drill", "B46", "attestRecoveryDrill", "recovery-drill", prefix("recovery-auditor:"), "passed"),
  decision("b47-release-promotion", "B47", "promoteRelease", "release-promotion", prefix("release-control:"), "approved"),
  decision("b48-business-loop", "B48", "submitBusinessLoopEvidence", "business-loop-certification", prefix("e2e-auditor:"), "certified"),
  decision("b49-release-evidence", "B49", "submitReleaseEvidence", "release-evidence", prefix("release-auditor:"), "approved"),
  report("b56-experience-gate", "B56", "approveExperienceGate", "experience-gate-report", prefix("experience-assurance:"), "releaseCandidate"),
  decision("b58-editorial-approval", "B58", "transitionEditorialContent", "editorial-approval", prefix("publication-review:"), "approved"),
  decision("b62-trust-document", "B62", "publishTrustDocument", "trust-document-attestation", prefix("trust-assurance:"), "approved"),
  decision("b68-mobile-assurance", "B68", "approveMobileAssurance", "mobile-assurance", prefix("mobile-assurance:"), "approved"),
  decision("b69-store-release", "B69", "approveMobileStoreRelease", "store-release", exact("apple-app-store", "google-play"), "approved"),
  decision("b72-mini-program-release", "B72", "approveMiniProgramRelease", "mini-program-release", exact("wechat-mini-program"), "approved"),
  decision("b77-deliverability", "B77", "recordDeliverabilityControl", "deliverability-control", prefix("notification:"), "verified"),
  decision("b91-payment-dispute", "B91", "recordDisputeDecision", "payment-dispute", prefix("payment:"), "approved"),
  decision("b92-partner-payout", "B92", "approvePartnerPayout", "partner-payout", prefix("payment:"), "approved"),
  decision("b94-financial-close", "B94", "approveMonthEndClose", "financial-close-export", prefix("erp:"), "approved"),
  decision("b96-vendor-profile", "B96", "recordVendorProfile", "vendor-profile", prefix("vendor:"), "verified"),
  decision("b97-production-proof", "B97", "recordProofApproval", "production-proof-lock", prefix("vendor:"), "approved"),
  decision("b107-connector-package", "B107", "publishConnector", "connector-package", prefix("crm:", "cloud:"), "published"),
  decision("b108-business-adapter", "B108", "registerBusinessAdapter", "business-adapter", prefix("crm:", "cloud:"), "verified"),
  decision("b109-partner-certification", "B109", "certifyPartnerIntegration", "partner-integration", prefix("crm:", "cloud:"), "certified"),
  report("b118-model-evaluation", "B118", "recordModelEvaluation", "model-evaluation-report", prefix("model-evaluator:"), "evaluationId"),
  report("b119-configuration-change", "B119", "approveConfigurationChange", "configuration-change-report", prefix("change-control:"), "changeId"),
  decision("b120-cloud-residency", "B120", "publishResidencyPolicy", "cloud-residency", prefix("cloud:"), "published"),
  report("b121-capacity-gate", "B121", "approveCapacityGate", "capacity-test-report", prefix("load-test:"), "testRunId"),
  report("b122-resilience-exercise", "B122", "recordResilienceExercise", "resilience-exercise-report", prefix("resilience-auditor:"), "exerciseId"),
  decision("b123-independent-pentest", "B123", "approveSecurityAssurance", "independent-pentest", prefix("pentest:"), "passed"),
  decision("b124-compliance", "B124", "approveComplianceEvidence", "compliance-attestation", prefix("compliance:"), "approved"),
  decision("b125-commercial-readiness", "B125", "approveCommercialReadiness", "commercial-readiness", prefix("readiness-auditor:"), "approved"),
  decision("b126-commercial-e2e", "B126", "certifyCommercialE2e", "commercial-e2e", prefix("e2e-auditor:"), "certified"),
]);

const REQUEST_SUBJECT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  B37: "experienceId", B44: "baselineId", B46: "drillId", B47: "releaseId",
  B48: "certificationRunId", B49: "releaseId", B56: "releaseCandidate", B58: "contentId",
  B62: "documentId", B68: "buildId", B69: "releaseId", B72: "releaseId",
  B77: "providerId", B91: "disputeId", B92: "payoutId", B94: "closeId",
  B96: "vendorId", B97: "approvalId", B107: "connectorId", B108: "adapterId",
  B109: "certificationId", B118: "evaluationId", B119: "changeId", B120: "policyId",
  B121: "testRunId", B122: "exerciseId", B123: "assessmentId", B124: "assessmentId",
  B125: "readinessId", B126: "certificationId",
});

export interface DirectEvidenceAuthorityConfiguration {
  readonly tenantId: string;
  readonly evidenceEnvironment: EvidenceEnvironment;
}

export interface LoadedDirectEvidenceAuthority {
  readonly route: DirectEvidenceRouteDefinition;
  readonly provider: string;
  readonly signatureScheme: PartnerWebhookSignatureScheme;
  readonly verificationKeyReference: SecretReference;
  readonly maximumClockSkewSeconds: number;
  readonly maximumBodyBytes: number;
  readonly retentionClass: "financial" | "release" | "operational";
  readonly binding: CapabilityEvidenceBindingTemplate;
}

export interface DirectEvidenceCallbackDependencies {
  readonly secrets: SecretResolver;
  readonly replays: ReplayStore;
  readonly artifacts: EvidenceArtifactStore;
  readonly attestor: EvidenceAttestor;
  readonly clock?: () => Date;
}

export function parseDirectEvidenceAuthorityDocument(
  value: unknown,
  configuration: DirectEvidenceAuthorityConfiguration,
): readonly LoadedDirectEvidenceAuthority[] {
  const document = objectValue(value, "direct evidence authority document");
  assertExactKeys(document, TOP_LEVEL_KEYS, "direct evidence authority document");
  if (document.version !== POLICY_VERSION || !Array.isArray(document.authorities) ||
      document.authorities.length < DIRECT_EVIDENCE_CALLBACK_ROUTES.length || document.authorities.length > 128) {
    throw configurationError(
      `direct evidence authority document must use ${POLICY_VERSION} with 30 to 128 authorities`,
    );
  }
  const routes = new Map(DIRECT_EVIDENCE_CALLBACK_ROUTES.map((route) => [route.routeId, route]));
  const seen = new Set<string>();
  const loaded = document.authorities.map((candidate) => {
    const authority = objectValue(candidate, "direct evidence authority");
    assertExactKeys(authority, AUTHORITY_KEYS, "direct evidence authority");
    const routeId = configIdentifier(requiredString(authority.routeId, "direct evidence routeId", 64), "direct evidence routeId");
    const route = routes.get(routeId);
    if (route === undefined) throw configurationError(`unknown direct evidence route ${routeId}`);
    const provider = configIdentifier(requiredString(authority.provider, "direct evidence provider", 128), "direct evidence provider");
    if (!providerAllowed(route.providerRule, provider)) {
      throw configurationError(`direct evidence provider ${provider} is not allowed for route ${routeId}`);
    }
    const identity = `${routeId}:${provider}`;
    if (seen.has(identity)) throw configurationError(`direct evidence authority ${identity} is duplicated`);
    seen.add(identity);
    const binding = {
      tenantId: configuration.tenantId,
      batchId: route.batchId,
      operation: route.operation,
      kind: route.evidenceKind,
      provider,
      environment: configuration.evidenceEnvironment,
      subjectId: "configuration-check",
    } as CapabilityEvidenceBindingTemplate;
    try {
      assertCapabilityEvidenceBinding({ ...binding, artifactSha256: "0".repeat(64) } as CapabilityEvidenceBinding);
    } catch {
      throw configurationError(`direct evidence authority ${identity} has an invalid evidence binding`);
    }
    return {
      route,
      provider,
      signatureScheme: enumValue(authority.signatureScheme, "direct evidence signatureScheme", ["hmac-sha256", "ed25519", "es256"] as const),
      verificationKeyReference: managedReference(authority.verificationKeyReference, "direct evidence verificationKeyReference"),
      maximumClockSkewSeconds: integer(authority.maximumClockSkewSeconds, 30, 900, "direct evidence maximumClockSkewSeconds"),
      maximumBodyBytes: integer(authority.maximumBodyBytes, 1_024, 1_048_576, "direct evidence maximumBodyBytes"),
      retentionClass: enumValue(authority.retentionClass, "direct evidence retentionClass", ["financial", "release", "operational"] as const),
      binding,
    } satisfies LoadedDirectEvidenceAuthority;
  });
  const missing = DIRECT_EVIDENCE_CALLBACK_ROUTES.filter((route) =>
    !loaded.some((authority) => authority.route.routeId === route.routeId));
  if (missing.length > 0) {
    throw configurationError(`direct evidence authority document is missing routes: ${missing.map((route) => route.routeId).join(",")}`);
  }
  return loaded;
}

export async function loadDirectEvidenceAuthorities(
  reference: SecretReference,
  secrets: SecretResolver,
  configuration: DirectEvidenceAuthorityConfiguration,
): Promise<readonly LoadedDirectEvidenceAuthority[]> {
  const bytes = Buffer.from(await secrets.resolve(reference));
  try {
    return parseDirectEvidenceAuthorityDocument(
      parseJsonObject(bytes, "direct evidence authority document"),
      configuration,
    );
  } finally {
    bytes.fill(0);
  }
}

export function createDirectEvidenceCallbackHandlers(
  authorities: readonly LoadedDirectEvidenceAuthority[],
  dependencies: DirectEvidenceCallbackDependencies,
): ReadonlyMap<string, GatewayCallbackHandler> {
  const handlers = new Map<string, GatewayCallbackHandler>();
  for (const route of DIRECT_EVIDENCE_CALLBACK_ROUTES) {
    const routeAuthorities = authorities.filter((authority) => authority.route.routeId === route.routeId);
    if (routeAuthorities.length === 0) throw configurationError(`direct evidence route ${route.routeId} has no authority`);
    const byProvider = new Map(routeAuthorities.map((authority) => [authority.provider, authority]));
    const integrations = new Map(routeAuthorities.map((authority) => [
      authority.provider,
      new SignedPartnerWebhookIntegration<CapabilityEvidenceBindingTemplate>({
        provider: authority.binding.provider,
        signatureScheme: authority.signatureScheme,
        verificationKeyReference: authority.verificationKeyReference,
        maximumClockSkewSeconds: authority.maximumClockSkewSeconds,
        retentionClass: authority.retentionClass,
        validate(payload, binding) {
          validateDirectEvidencePayload(route, payload, binding);
        },
      }, dependencies.secrets, dependencies.replays, dependencies.artifacts, dependencies.attestor, dependencies.clock),
    ]));
    handlers.set(directEvidenceCallbackPath(route), {
      maximumBodyBytes: Math.max(...routeAuthorities.map((authority) => authority.maximumBodyBytes)),
      async process(request) {
        const payload = parseJsonObject(request.rawBody, "direct evidence callback");
        const provider = identifier(requiredString(payload.provider, "direct evidence provider", 128), "direct evidence provider");
        const authority = byProvider.get(provider);
        const integration = integrations.get(provider);
        if (authority === undefined || integration === undefined) {
          throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "direct evidence authority is not enrolled");
        }
        if (request.rawBody.byteLength > authority.maximumBodyBytes) {
          throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "direct evidence callback exceeds its authority body limit");
        }
        const subjectId = directEvidenceSubject(route, payload);
        const requestSha256 = directEvidenceRequestDigest(route, payload, subjectId);
        const binding = { ...authority.binding, subjectId, requestSha256 } as CapabilityEvidenceBindingTemplate;
        const evidence = await integration.verifyAndAttest({
          binding,
          rawBody: request.rawBody,
          timestamp: requiredHeader(request.headers, "x-ltm-timestamp"),
          nonce: requiredHeader(request.headers, "x-ltm-nonce"),
          signature: requiredHeader(request.headers, "x-ltm-signature"),
        });
        const evidenceEventId = identifier(
          requiredString(payload.evidenceEventId, "direct evidence eventId", 128),
          "direct evidence eventId",
        );
        return {
          disposition: "evidence" as const,
          providerEventId: evidenceEventId,
          evidence,
          receipt: {
            routeId: route.routeId,
            provider,
            subjectId,
            evidenceEventId,
            artifactSha256: evidence.artifactSha256,
            decisionRequestSha256: requestSha256,
          },
        };
      },
    });
  }
  return handlers;
}

export function directEvidenceCallbackPath(route: Pick<DirectEvidenceRouteDefinition, "routeId">): string {
  return `/v1/callbacks/partners/evidence-${route.routeId}`;
}

function validateDirectEvidencePayload(
  route: DirectEvidenceRouteDefinition,
  payload: Readonly<Record<string, unknown>>,
  binding: CapabilityEvidenceBindingTemplate,
): void {
  if (payload.version !== PAYLOAD_VERSION || payload.routeId !== route.routeId || payload.provider !== binding.provider) {
    throw providerInvalid("direct evidence callback route or provider binding is invalid");
  }
  const subjectId = directEvidenceSubject(route, payload);
  if (subjectId !== binding.subjectId) throw providerInvalid("direct evidence subject does not match its binding");
  const requestSha256 = directEvidenceRequestDigest(route, payload, subjectId);
  if (requestSha256 !== binding.requestSha256) {
    throw providerInvalid("direct evidence decision request does not match its binding");
  }
}

function directEvidenceSubject(
  route: DirectEvidenceRouteDefinition,
  payload: Readonly<Record<string, unknown>>,
): string {
  if (route.artifactType === "decision") {
    assertExactKeys(payload, DECISION_PAYLOAD_KEYS, "direct evidence decision callback", providerInvalid);
    if (payload.version !== PAYLOAD_VERSION || payload.routeId !== route.routeId ||
        payload.decision !== route.expectedDecision) {
      throw providerInvalid("direct evidence decision does not match its fixed route contract");
    }
    identifier(requiredString(payload.provider, "direct evidence provider", 128), "direct evidence provider");
    identifier(requiredString(payload.evidenceEventId, "direct evidence eventId", 128), "direct evidence eventId");
    const subjectId = identifier(requiredString(payload.subjectId, "direct evidence subjectId", 128), "direct evidence subjectId");
    identifier(requiredString(payload.decisionReference, "direct evidence decisionReference", 128), "direct evidence decisionReference");
    const occurredAt = requiredString(payload.providerOccurredAt, "direct evidence providerOccurredAt", 64);
    if (!isTimestamp(occurredAt)) throw providerInvalid("direct evidence providerOccurredAt is invalid");
    validateClaims(payload.claims);
    return subjectId;
  }
  assertExactKeys(payload, REPORT_PAYLOAD_KEYS, "direct evidence report callback", providerInvalid);
  if (payload.version !== PAYLOAD_VERSION || payload.routeId !== route.routeId) {
    throw providerInvalid("direct evidence report does not match its fixed route contract");
  }
  identifier(requiredString(payload.provider, "direct evidence provider", 128), "direct evidence provider");
  identifier(requiredString(payload.evidenceEventId, "direct evidence eventId", 128), "direct evidence eventId");
  const reportValue = objectValue(payload.report, "direct evidence operational report", providerInvalid);
  const subjectId = identifier(
    requiredString(reportValue[route.reportSubjectField], `direct evidence report ${route.reportSubjectField}`, 128),
    `direct evidence report ${route.reportSubjectField}`,
  );
  const reportBytes = Buffer.from(canonicalJson(reportValue), "utf8");
  try {
    const reportValueParsed = parseOperationalReport({
      tenantId: "validation-tenant",
      batchId: route.batchId,
      operation: route.operation,
      kind: route.evidenceKind,
      provider: requiredString(payload.provider, "direct evidence provider", 128),
      artifactSha256: "0".repeat(64),
      environment: "test",
      subjectId,
    } as OperationalReportEvidenceBinding, reportBytes);
    const request = decisionRequestObject(payload);
    assertOperationalReportRequestBinding(route, reportValueParsed as unknown as Readonly<Record<string, unknown>>, request);
  } finally {
    reportBytes.fill(0);
  }
  return subjectId;
}

function directEvidenceRequestDigest(
  route: DirectEvidenceRouteDefinition,
  payload: Readonly<Record<string, unknown>>,
  subjectId: string,
): string {
  const request = decisionRequestObject(payload);
  const requestSubjectField = REQUEST_SUBJECT_FIELDS[route.batchId];
  if (requestSubjectField === undefined || request[requestSubjectField] !== subjectId) {
    throw providerInvalid("direct evidence subject does not match its canonical decision request");
  }
  const supplied = requiredString(payload.decisionRequestSha256, "direct evidence decisionRequestSha256", 64);
  if (!/^[a-f0-9]{64}$/.test(supplied)) {
    throw providerInvalid("direct evidence decisionRequestSha256 is invalid");
  }
  const computed = decisionRequestSha256(route.batchId, route.operation, request as JsonObject);
  if (computed !== supplied) throw providerInvalid("direct evidence decision request digest does not match its payload");
  return computed;
}

function decisionRequestObject(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const request = objectValue(payload.decisionRequest, "direct evidence decisionRequest", providerInvalid);
  const keys = Object.keys(request);
  if (keys.length < 1 || keys.length > 128) throw providerInvalid("direct evidence decisionRequest has an invalid field count");
  visitRequestJson(request, 0, new Set<object>());
  return request;
}

function visitRequestJson(value: unknown, depth: number, ancestors: Set<object>): void {
  if (depth > 12) throw providerInvalid("direct evidence decisionRequest exceeds the maximum depth");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 16_384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw providerInvalid("direct evidence decisionRequest string is invalid");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw providerInvalid("direct evidence decisionRequest number is invalid");
    }
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw providerInvalid("direct evidence decisionRequest must contain acyclic JSON values only");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > 512) throw providerInvalid("direct evidence decisionRequest array is too large");
    for (const entry of value) visitRequestJson(entry, depth + 1, ancestors);
  } else {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 256) throw providerInvalid("direct evidence decisionRequest object is too large");
    for (const [key, entry] of entries) {
      if (!JSON_KEY.test(key)) throw providerInvalid("direct evidence decisionRequest field is invalid");
      visitRequestJson(entry, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertOperationalReportRequestBinding(
  route: OperationalReportRouteDefinition,
  report: Readonly<Record<string, unknown>>,
  request: Readonly<Record<string, unknown>>,
): void {
  const pairs: Readonly<Record<OperationalReportRouteDefinition["batchId"], readonly (readonly [string, string])[]>> = {
    B56: [["releaseCandidate", "releaseCandidate"], ["baselineId", "baselineId"]],
    B118: [
      ["evaluationId", "evaluationId"], ["modelVersion", "modelVersion"],
      ["promptVersion", "promptVersion"], ["datasetId", "datasetId"],
      ["cohorts", "cohorts"], ["metrics", "metrics"],
    ],
    B119: [
      ["changeId", "changeId"], ["targetEnvironment", "environment"],
      ["schemaVersion", "schemaVersion"], ["changedFields", "changedFields"],
    ],
    B121: [
      ["testRunId", "testRunId"], ["scenarios", "scenarios"],
      ["maxP95Ms", "maxP95Ms"], ["maxErrorRate", "maxErrorRate"],
    ],
    B122: [
      ["exerciseId", "exerciseId"], ["targetRtoSeconds", "targetRtoSeconds"],
      ["targetRpoSeconds", "targetRpoSeconds"], ["failoverRegion", "failoverRegion"],
    ],
  };
  for (const [reportField, requestField] of pairs[route.batchId]) {
    if (!Object.prototype.hasOwnProperty.call(report, reportField) ||
        !Object.prototype.hasOwnProperty.call(request, requestField) ||
        canonicalJson(report[reportField]) !== canonicalJson(request[requestField])) {
      throw providerInvalid(`signed operational report ${reportField} does not match the decision request`);
    }
  }
  const schemaField = route.batchId === "B56" ? "reportPolicyVersion" : "reportSchemaVersion";
  const schema = request[schemaField];
  const fixed = report.version;
  if (typeof fixed !== "string" || (schema !== fixed && schema !== "1.0.0")) {
    throw providerInvalid("signed operational report schema does not match the decision request");
  }
}

function validateClaims(value: unknown): void {
  const claims = objectValue(value, "direct evidence claims", providerInvalid);
  const keys = Object.keys(claims);
  if (keys.length < 1 || keys.length > 64) throw providerInvalid("direct evidence claims must contain one to 64 fields");
  visitJson(claims, 0, new Set<object>());
}

function visitJson(value: unknown, depth: number, ancestors: Set<object>): void {
  if (depth > 8) throw providerInvalid("direct evidence claims exceed the maximum depth");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 8_192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw providerInvalid("direct evidence claim string is invalid");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw providerInvalid("direct evidence claim number is invalid");
    return;
  }
  if (typeof value !== "object") throw providerInvalid("direct evidence claims must contain JSON values only");
  if (ancestors.has(value)) throw providerInvalid("direct evidence claims contain a cycle");
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > 256) throw providerInvalid("direct evidence claim array is too large");
    for (const entry of value) visitJson(entry, depth + 1, ancestors);
  } else {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 128) throw providerInvalid("direct evidence claim object is too large");
    for (const [key, entry] of entries) {
      if (!JSON_KEY.test(key) || FORBIDDEN_CLAIM_FIELDS.has(key)) {
        throw providerInvalid(`direct evidence claims contain forbidden field ${key}`);
      }
      visitJson(entry, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

function providerAllowed(rule: ProviderRule, provider: string): boolean {
  return (rule.exact?.includes(provider) ?? false) ||
    (rule.prefixes?.some((value) => provider.startsWith(value) && provider.length > value.length) ?? false);
}

function decision(
  routeId: string,
  batchId: `B${string}`,
  operation: string,
  evidenceKind: string,
  providerRule: ProviderRule,
  expectedDecision: DirectEvidenceDecision,
): DecisionRouteDefinition {
  return { artifactType: "decision", routeId, batchId, operation, evidenceKind, providerRule, expectedDecision };
}

function report(
  routeId: string,
  batchId: OperationalReportRouteDefinition["batchId"],
  operation: string,
  evidenceKind: string,
  providerRule: ProviderRule,
  reportSubjectField: string,
): OperationalReportRouteDefinition {
  return { artifactType: "operational-report", routeId, batchId, operation, evidenceKind, providerRule, reportSubjectField };
}

function requiredHeader(headers: Readonly<Record<string, string>>, name: string): string {
  const value = headers[name];
  if (value === undefined) throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", `${name} header is required`);
  return value;
}

function managedReference(value: unknown, label: string): SecretReference {
  const reference = requiredString(value, label, 2_048);
  if (!reference.startsWith("secret-manager:") || reference.length === "secret-manager:".length) {
    throw configurationError(`${label} must use AWS Secrets Manager`);
  }
  return reference as SecretReference;
}

function objectValue(
  value: unknown,
  label: string,
  errorFactory: (message: string) => Error = configurationError,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errorFactory(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
  errorFactory: (message: string) => Error = configurationError,
): void {
  const expectedSet = new Set(expected);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expectedSet.has(key))) {
    throw errorFactory(`${label} has missing or unsupported fields`);
  }
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw providerInvalid(`${label} is invalid`);
  return value;
}

function configIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw configurationError(`${label} is invalid`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw configurationError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw configurationError(`${label} is invalid`);
  return value as T;
}

function isTimestamp(value: string): boolean {
  const seconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value);
  const milliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
  const parsed = Date.parse(value);
  if ((!seconds && !milliseconds) || !Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return milliseconds ? canonical === value : canonical === value.replace(/Z$/, ".000Z");
}

function configurationError(message: string): ProductionIntegrationError {
  return new ProductionIntegrationError("CONFIGURATION_INVALID", message);
}

function providerInvalid(message: string): ProductionIntegrationError {
  return new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", message);
}
