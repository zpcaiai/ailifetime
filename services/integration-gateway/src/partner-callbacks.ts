import {
  EXTERNAL_COMMAND_CALLBACK_ROUTES,
  externalCommandCallbackProviderAllowed,
  type ExternalCommandCallbackRouteDefinition,
  type ExternalCommandTerminalState,
} from "@ltm/core";
import {
  ProductionIntegrationError,
  SignedPartnerWebhookIntegration,
  assertCapabilityEvidenceBinding,
  parseJsonObject,
  requiredString,
  type CapabilityEvidenceBinding,
  type CapabilityEvidenceBindingTemplate,
  type EvidenceArtifactStore,
  type EvidenceAttestor,
  type EvidenceEnvironment,
  type PartnerWebhookSignatureScheme,
  type ReplayStore,
  type SecretReference,
  type SecretResolver,
} from "@ltm/providers";
import type { GatewayCallbackHandler } from "./gateway.js";

const POLICY_VERSION = "ltm.partner-webhook-policies.v2";
const TERMINAL_STATES = ["succeeded", "failed", "cancelled", "compensated"] as const;
const TOP_LEVEL_KEYS = ["version", "routes"] as const;
const ROUTE_KEYS = [
  "routeId",
  "batchId",
  "operation",
  "evidenceKind",
  "provider",
  "signatureScheme",
  "verificationKeyReference",
  "maximumClockSkewSeconds",
  "maximumBodyBytes",
  "retentionClass",
  "commandIdField",
  "eventIdField",
  "terminalStateField",
  "providerOccurredAtField",
  "sequenceField",
  "providerOperationIdField",
  "requiredClaimFields",
  "terminalStateMap",
] as const;
const CALLER_CONTROL_FIELDS = new Set([
  "tenant",
  "tenantId",
  "batchId",
  "operation",
  "evidenceKind",
  "kind",
  "provider",
  "collection",
  "aggregateId",
  "subjectId",
  "subjectType",
  "correlationId",
  "patch",
  "terminal",
  "isTerminal",
]);
const CALLER_TERMINAL_BOOLEAN_FIELDS = new Set([
  "success",
  "succeeded",
  "failed",
  "cancelled",
  "compensated",
]);

export interface ExternalCommandPartnerPolicyConfiguration {
  readonly tenantId: string;
  readonly evidenceEnvironment: EvidenceEnvironment;
}

export interface LoadedExternalCommandPartnerPolicy {
  readonly routeId: ExternalCommandCallbackRouteDefinition["routeId"];
  readonly routeDefinition: ExternalCommandCallbackRouteDefinition;
  readonly binding: CapabilityEvidenceBindingTemplate;
  readonly signatureScheme: PartnerWebhookSignatureScheme;
  readonly verificationKeyReference: SecretReference;
  readonly maximumClockSkewSeconds: number;
  readonly maximumBodyBytes: number;
  readonly retentionClass: "financial" | "release" | "operational";
  readonly commandIdField: string;
  readonly eventIdField: string;
  readonly terminalStateField: string;
  readonly providerOccurredAtField: string;
  readonly sequenceField: string;
  readonly providerOperationIdField: string;
  readonly requiredClaimFields: Readonly<Record<string, string>>;
  readonly terminalStateMap: Readonly<Record<string, ExternalCommandTerminalState>>;
}

export interface ExternalCommandPartnerCallbackDependencies {
  readonly secrets: SecretResolver;
  readonly replays: ReplayStore;
  readonly artifacts: EvidenceArtifactStore;
  readonly attestor: EvidenceAttestor;
  readonly clock?: () => Date;
}

/**
 * Parse the managed production policy as a closed inventory. A deployment may
 * configure the concrete authority for dynamic provider families, but it may
 * neither add a route nor omit one of the core-owned command routes.
 */
export function parseExternalCommandPartnerPolicyDocument(
  value: unknown,
  configuration: ExternalCommandPartnerPolicyConfiguration,
): readonly LoadedExternalCommandPartnerPolicy[] {
  const payload = objectValue(value, "partner webhook policy document");
  assertExactKeys(payload, TOP_LEVEL_KEYS, "partner webhook policy document");
  if (payload.version !== POLICY_VERSION || !Array.isArray(payload.routes)) {
    throw configurationError(`partner webhook policy document must use ${POLICY_VERSION}`);
  }
  if (payload.routes.length !== EXTERNAL_COMMAND_CALLBACK_ROUTES.length) {
    throw configurationError(`partner webhook policy document must define exactly ${EXTERNAL_COMMAND_CALLBACK_ROUTES.length} routes`);
  }

  const definitionsById = new Map<string, ExternalCommandCallbackRouteDefinition>(
    EXTERNAL_COMMAND_CALLBACK_ROUTES.map((definition) => [definition.routeId, definition]),
  );
  const seen = new Set<string>();
  const policies = payload.routes.map((candidate) => {
    const record = objectValue(candidate, "partner webhook route");
    assertExactKeys(record, ROUTE_KEYS, "partner webhook route");
    const routeId = routeToken(requiredString(record.routeId, "partner routeId", 64));
    if (seen.has(routeId)) throw configurationError(`partner route ${routeId} is duplicated`);
    seen.add(routeId);
    const routeDefinition = definitionsById.get(routeId);
    if (routeDefinition === undefined) throw configurationError(`partner route ${routeId} is not in the core command inventory`);

    const batchId = requiredString(record.batchId, "partner batchId", 16);
    const operation = requiredString(record.operation, "partner operation", 160);
    const evidenceKind = requiredString(record.evidenceKind, "partner evidenceKind", 160);
    if (batchId !== routeDefinition.batchId || operation !== routeDefinition.operation ||
        evidenceKind !== routeDefinition.evidenceKind) {
      throw configurationError(`partner route ${routeId} does not match its core batch/operation/evidenceKind contract`);
    }
    const provider = configuredIdentifier(requiredString(record.provider, "partner provider", 128), "partner provider");
    if (!externalCommandCallbackProviderAllowed(routeDefinition, provider)) {
      throw configurationError(`partner route ${routeId} provider does not match its core authority binding`);
    }

    const commandIdField = jsonPath(requiredString(record.commandIdField, "partner commandIdField", 256));
    const eventIdField = jsonPath(requiredString(record.eventIdField, "partner eventIdField", 256));
    const terminalStateField = jsonPath(requiredString(record.terminalStateField, "partner terminalStateField", 256));
    const providerOccurredAtField = jsonPath(requiredString(record.providerOccurredAtField, "partner providerOccurredAtField", 256));
    const sequenceField = jsonPath(requiredString(record.sequenceField, "partner sequenceField", 256));
    const providerOperationIdField = jsonPath(requiredString(record.providerOperationIdField, "partner providerOperationIdField", 256));
    const requiredClaimFieldsValue = objectValue(record.requiredClaimFields, "partner requiredClaimFields");
    const expectedRequiredClaims = routeDefinition.requiredClaimIdentifiers ?? [];
    if (Object.keys(requiredClaimFieldsValue).length !== expectedRequiredClaims.length ||
        Object.keys(requiredClaimFieldsValue).some((field) => !expectedRequiredClaims.includes(field))) {
      throw configurationError(`partner route ${routeId} requiredClaimFields do not match its core claim contract`);
    }
    const requiredClaimFields = Object.fromEntries(expectedRequiredClaims.map((field) => [
      field,
      jsonPath(requiredString(requiredClaimFieldsValue[field], `partner requiredClaimFields.${field}`, 256)),
    ]));
    const mappedPaths = [
      commandIdField,
      eventIdField,
      terminalStateField,
      providerOccurredAtField,
      sequenceField,
      providerOperationIdField,
      ...Object.values(requiredClaimFields),
    ];
    if (new Set(mappedPaths).size !== mappedPaths.length) {
      throw configurationError(`partner route ${routeId} native field paths must be distinct`);
    }
    for (const path of mappedPaths) assertProviderOwnedPath(path, routeId);

    const terminalStateMapValue = objectValue(record.terminalStateMap, "partner terminalStateMap");
    if (Object.keys(terminalStateMapValue).length < TERMINAL_STATES.length || Object.keys(terminalStateMapValue).length > 32) {
      throw configurationError(`partner route ${routeId} terminalStateMap must be non-empty and bounded`);
    }
    const terminalStateMap: Record<string, ExternalCommandTerminalState> = Object.create(null) as Record<string, ExternalCommandTerminalState>;
    for (const [nativeValue, terminalValue] of Object.entries(terminalStateMapValue)) {
      terminalStateMap[configuredIdentifier(nativeValue, "partner native terminal state")] = enumValue(
        terminalValue,
        "partner terminal state",
        TERMINAL_STATES,
      );
    }
    if (TERMINAL_STATES.some((terminal) => !Object.values(terminalStateMap).includes(terminal))) {
      throw configurationError(`partner route ${routeId} terminalStateMap must cover all four terminal states`);
    }

    const binding = {
      tenantId: configuration.tenantId,
      batchId: routeDefinition.batchId,
      operation: routeDefinition.operation,
      kind: routeDefinition.evidenceKind,
      provider,
      environment: configuration.evidenceEnvironment,
      subjectId: "configuration-check",
    } as CapabilityEvidenceBindingTemplate;
    try {
      assertCapabilityEvidenceBinding({ ...binding, artifactSha256: "0".repeat(64) } as CapabilityEvidenceBinding);
    } catch {
      throw configurationError(`partner route ${routeId} has an unsupported evidence binding`);
    }

    return {
      routeId: routeDefinition.routeId,
      routeDefinition,
      binding,
      signatureScheme: enumValue(record.signatureScheme, "partner signatureScheme", ["hmac-sha256", "ed25519", "es256"] as const),
      verificationKeyReference: managedReference(record.verificationKeyReference, "partner verificationKeyReference"),
      maximumClockSkewSeconds: requiredInteger(record.maximumClockSkewSeconds, 30, 900, "partner maximumClockSkewSeconds"),
      maximumBodyBytes: requiredInteger(record.maximumBodyBytes, 1_024, 10_485_760, "partner maximumBodyBytes"),
      retentionClass: enumValue(record.retentionClass, "partner retentionClass", ["financial", "release", "operational"] as const),
      commandIdField,
      eventIdField,
      terminalStateField,
      providerOccurredAtField,
      sequenceField,
      providerOperationIdField,
      requiredClaimFields,
      terminalStateMap,
    } satisfies LoadedExternalCommandPartnerPolicy;
  });

  const missing = EXTERNAL_COMMAND_CALLBACK_ROUTES.filter((definition) => !seen.has(definition.routeId));
  if (missing.length > 0) {
    throw configurationError(`partner webhook policy is missing core routes: ${missing.map((route) => route.routeId).join(",")}`);
  }
  return policies;
}

export async function loadExternalCommandPartnerPolicies(
  reference: SecretReference,
  secrets: SecretResolver,
  configuration: ExternalCommandPartnerPolicyConfiguration,
): Promise<readonly LoadedExternalCommandPartnerPolicy[]> {
  const bytes = Buffer.from(await secrets.resolve(reference));
  try {
    return parseExternalCommandPartnerPolicyDocument(
      parseJsonObject(bytes, "partner webhook policy document"),
      configuration,
    );
  } finally {
    bytes.fill(0);
  }
}

export function createExternalCommandPartnerCallbackHandler(
  policy: LoadedExternalCommandPartnerPolicy,
  dependencies: ExternalCommandPartnerCallbackDependencies,
): GatewayCallbackHandler {
  const integration = new SignedPartnerWebhookIntegration<CapabilityEvidenceBindingTemplate>({
    provider: policy.binding.provider,
    signatureScheme: policy.signatureScheme,
    verificationKeyReference: policy.verificationKeyReference,
    maximumClockSkewSeconds: policy.maximumClockSkewSeconds,
    retentionClass: policy.retentionClass,
    validate(payload, binding) {
      validateVerifiedNativePayload(policy, payload, binding.subjectId);
    },
  }, dependencies.secrets, dependencies.replays, dependencies.artifacts, dependencies.attestor, dependencies.clock);

  return {
    maximumBodyBytes: policy.maximumBodyBytes,
    async process(request) {
      // Only commandId is needed to construct the evidence subject before the
      // signature check. The exact signed payload is validated against it and
      // all business fields are resolved by the post-verification callback.
      const unverifiedPayload = parseJsonObject(request.rawBody, "partner webhook body");
      const commandId = identifier(
        requiredString(pathValue(unverifiedPayload, policy.commandIdField), "partner commandId", 128),
        "partner commandId",
      );
      const binding = { ...policy.binding, subjectId: commandId } as CapabilityEvidenceBindingTemplate;
      const result = await integration.verifyAndAttestExternalCommandTerminal({
        binding,
        rawBody: request.rawBody,
        timestamp: requiredHeader(request.headers, "x-ltm-timestamp"),
        nonce: requiredHeader(request.headers, "x-ltm-nonce"),
        signature: requiredHeader(request.headers, "x-ltm-signature"),
      }, (verifiedPayload) => terminalCallbackFromVerifiedPayload(policy, verifiedPayload));
      return {
        disposition: "attested",
        providerEventId: result.event.eventId,
        evidence: result.evidence,
        businessEvent: result.event,
        receipt: {
          routeId: policy.routeId,
          provider: policy.binding.provider,
          commandId,
          terminalState: result.event.eventType.slice("external-command.".length),
          artifactSha256: result.evidence.artifactSha256,
        },
      };
    },
  };
}

export function partnerCallbackPath(policy: Pick<LoadedExternalCommandPartnerPolicy, "routeId">): string {
  return `/v1/callbacks/partners/${policy.routeId}`;
}

function terminalCallbackFromVerifiedPayload(
  policy: LoadedExternalCommandPartnerPolicy,
  payload: Readonly<Record<string, unknown>>,
) {
  assertNoCallerControlFields(payload);
  const nativeTerminalState = pathValue(payload, policy.terminalStateField);
  if (typeof nativeTerminalState !== "string") {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner terminal state must be a string");
  }
  const terminalState = policy.terminalStateMap[nativeTerminalState];
  if (terminalState === undefined) {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "partner terminal state is not allowlisted by route policy");
  }
  const occurredAt = requiredString(
    pathValue(payload, policy.providerOccurredAtField),
    "partner providerOccurredAt",
    64,
  );
  const occurredMilliseconds = Date.parse(occurredAt);
  if (!Number.isFinite(occurredMilliseconds)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner providerOccurredAt is invalid");
  }
  const sequence = pathValue(payload, policy.sequenceField);
  if (sequence !== null && (!Number.isSafeInteger(sequence) || (sequence as number) < 0)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner sequence must be null or a non-negative integer");
  }
  return {
    eventId: identifier(requiredString(pathValue(payload, policy.eventIdField), "partner eventId", 128), "partner eventId"),
    terminalState,
    providerOccurredAt: new Date(occurredMilliseconds).toISOString(),
    sequence: sequence as number | null,
    providerOperationId: identifier(
      requiredString(pathValue(payload, policy.providerOperationIdField), "partner providerOperationId", 128),
      "partner providerOperationId",
    ),
    requiredClaims: Object.fromEntries(Object.entries(policy.requiredClaimFields).map(([field, path]) => [
      field,
      identifier(requiredString(pathValue(payload, path), `partner ${field}`, 128), `partner ${field}`),
    ])),
  };
}

function validateVerifiedNativePayload(
  policy: LoadedExternalCommandPartnerPolicy,
  payload: Readonly<Record<string, unknown>>,
  commandId: string,
): void {
  const nativeCommandId = pathValue(payload, policy.commandIdField);
  if (nativeCommandId !== commandId) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner commandId does not match its evidence subject");
  }
  terminalCallbackFromVerifiedPayload(policy, payload);
}

function assertNoCallerControlFields(payload: Readonly<Record<string, unknown>>): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [field, fieldValue] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      if (CALLER_CONTROL_FIELDS.has(field) ||
          (CALLER_TERMINAL_BOOLEAN_FIELDS.has(field) && typeof fieldValue === "boolean")) {
        throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `partner payload contains forbidden control field ${field}`);
      }
      visit(fieldValue);
    }
  };
  visit(payload);
}

function requiredHeader(headers: Readonly<Record<string, string>>, name: string): string {
  const value = headers[name];
  if (value === undefined) throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", `${name} header is required`);
  return value;
}

function pathValue(value: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[part];
  }
  return current;
}

function assertProviderOwnedPath(path: string, routeId: string): void {
  const first = path.split(".")[0];
  if (first === undefined || CALLER_CONTROL_FIELDS.has(first)) {
    throw configurationError(`partner route ${routeId} maps a caller-owned control field`);
  }
}

function jsonPath(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,5}$/.test(value)) {
    throw configurationError("partner JSON field path is invalid");
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expectedSet.has(key))) {
    throw configurationError(`${label} has missing or unsupported fields`);
  }
}

function managedReference(value: unknown, label: string): SecretReference {
  const reference = requiredString(value, label, 2_048);
  if (!reference.startsWith("secret-manager:") || reference.length === "secret-manager:".length) {
    throw configurationError(`${label} must use AWS Secrets Manager`);
  }
  return reference as SecretReference;
}

function requiredInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw configurationError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function routeToken(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw configurationError("partner routeId is invalid");
  return value;
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${label} is invalid`);
  }
  return value;
}

function configuredIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || value === "__proto__" || value === "constructor") {
    throw configurationError(`${label} is invalid`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw configurationError(`${label} is invalid`);
  return value as T;
}

function configurationError(message: string): ProductionIntegrationError {
  return new ProductionIntegrationError("CONFIGURATION_INVALID", message);
}
