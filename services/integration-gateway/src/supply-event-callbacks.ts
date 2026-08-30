import {
  ProductionIntegrationError,
  SignedPartnerWebhookIntegration,
  assertCapabilityEvidenceBinding,
  parseJsonObject,
  requiredString,
  type BusinessEventDraft,
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
import type { JsonObject } from "@ltm/core";
import type { GatewayCallbackHandler } from "./gateway.js";

const POLICY_VERSION = "ltm.supply-event-authorities.v1";
const PAYLOAD_VERSION = "ltm.supply-event.v1";
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
const COMMON_PAYLOAD_KEYS = [
  "version",
  "routeId",
  "provider",
  "eventId",
  "subjectId",
  "eventType",
  "providerOccurredAt",
  "sequence",
] as const;

const SHIPMENT_EVENTS = new Set([
  "shipment.label_created",
  "shipment.picked_up",
  "shipment.in_transit",
  "shipment.delayed",
  "shipment.out_for_delivery",
  "shipment.delivered",
  "shipment.exception",
  "shipment.returned",
  "shipment.cancelled",
]);
const SCORECARD_EVENTS = new Set([
  "scorecard.vendor_job",
  "scorecard.shipment",
  "scorecard.claim",
  "scorecard.settlement",
]);

export type SupplyEventRouteId = "b99-shipment-fact" | "b100-inventory-fact" | "b102-scorecard-fact";

interface SupplyEventRouteDefinition {
  readonly routeId: SupplyEventRouteId;
  readonly batchId: "B99" | "B100" | "B102";
  readonly operation: "recordShipment" | "recordInventoryAdjustment" | "publishVendorScorecard";
  readonly evidenceKind: "carrier-event" | "inventory-snapshot" | "vendor-scorecard";
  readonly providerPrefix: "carrier:" | "vendor:";
  readonly subjectType: "shipment" | "inventory-item" | "vendor";
}

export const SUPPLY_EVENT_CALLBACK_ROUTES: readonly SupplyEventRouteDefinition[] = Object.freeze([
  {
    routeId: "b99-shipment-fact",
    batchId: "B99",
    operation: "recordShipment",
    evidenceKind: "carrier-event",
    providerPrefix: "carrier:",
    subjectType: "shipment",
  },
  {
    routeId: "b100-inventory-fact",
    batchId: "B100",
    operation: "recordInventoryAdjustment",
    evidenceKind: "inventory-snapshot",
    providerPrefix: "vendor:",
    subjectType: "inventory-item",
  },
  {
    routeId: "b102-scorecard-fact",
    batchId: "B102",
    operation: "publishVendorScorecard",
    evidenceKind: "vendor-scorecard",
    providerPrefix: "vendor:",
    subjectType: "vendor",
  },
]);

export interface SupplyEventAuthorityConfiguration {
  readonly tenantId: string;
  readonly evidenceEnvironment: EvidenceEnvironment;
}

export interface LoadedSupplyEventAuthority {
  readonly route: SupplyEventRouteDefinition;
  readonly provider: `carrier:${string}` | `vendor:${string}`;
  readonly signatureScheme: PartnerWebhookSignatureScheme;
  readonly verificationKeyReference: SecretReference;
  readonly maximumClockSkewSeconds: number;
  readonly maximumBodyBytes: number;
  readonly retentionClass: "financial" | "release" | "operational";
  readonly binding: CapabilityEvidenceBindingTemplate;
}

export interface SupplyEventCallbackDependencies {
  readonly secrets: SecretResolver;
  readonly replays: ReplayStore;
  readonly artifacts: EvidenceArtifactStore;
  readonly attestor: EvidenceAttestor;
  readonly clock?: () => Date;
}

/** Parse a closed, managed authority inventory with at least one signer for each provider-fact route. */
export function parseSupplyEventAuthorityDocument(
  value: unknown,
  configuration: SupplyEventAuthorityConfiguration,
): readonly LoadedSupplyEventAuthority[] {
  const document = objectValue(value, "supply event authority document");
  assertExactKeys(document, TOP_LEVEL_KEYS, "supply event authority document");
  if (document.version !== POLICY_VERSION || !Array.isArray(document.authorities) ||
      document.authorities.length < SUPPLY_EVENT_CALLBACK_ROUTES.length || document.authorities.length > 128) {
    throw configurationError(`supply event authority document must use ${POLICY_VERSION} with three to 128 authorities`);
  }
  const routes = new Map(SUPPLY_EVENT_CALLBACK_ROUTES.map((route) => [route.routeId, route]));
  const seen = new Set<string>();
  const loaded = document.authorities.map((candidate) => {
    const authority = objectValue(candidate, "supply event authority");
    assertExactKeys(authority, AUTHORITY_KEYS, "supply event authority");
    const routeId = requiredString(authority.routeId, "supply routeId", 64) as SupplyEventRouteId;
    const route = routes.get(routeId);
    if (route === undefined) throw configurationError(`unknown supply event route ${routeId}`);
    const provider = payloadIdentifier(
      requiredString(authority.provider, "supply provider", 128),
      "supply provider",
      true,
    ) as `carrier:${string}` | `vendor:${string}`;
    if (!provider.startsWith(route.providerPrefix) || provider.length === route.providerPrefix.length) {
      throw configurationError(`supply provider ${provider} does not match route ${routeId}`);
    }
    const identity = `${routeId}:${provider}`;
    if (seen.has(identity)) throw configurationError(`supply event authority ${identity} is duplicated`);
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
      throw configurationError(`supply event authority ${identity} has an invalid evidence binding`);
    }
    return {
      route,
      provider,
      signatureScheme: enumValue(authority.signatureScheme, "supply signatureScheme", ["hmac-sha256", "ed25519", "es256"] as const),
      verificationKeyReference: managedReference(authority.verificationKeyReference, "supply verificationKeyReference"),
      maximumClockSkewSeconds: integer(authority.maximumClockSkewSeconds, 30, 900, "supply maximumClockSkewSeconds"),
      maximumBodyBytes: integer(authority.maximumBodyBytes, 1_024, 1_048_576, "supply maximumBodyBytes"),
      retentionClass: enumValue(authority.retentionClass, "supply retentionClass", ["financial", "release", "operational"] as const),
      binding,
    } satisfies LoadedSupplyEventAuthority;
  });
  const missing = SUPPLY_EVENT_CALLBACK_ROUTES.filter((route) =>
    !loaded.some((authority) => authority.route.routeId === route.routeId));
  if (missing.length > 0) {
    throw configurationError(`supply event authority document is missing routes: ${missing.map((route) => route.routeId).join(",")}`);
  }
  return loaded;
}

export async function loadSupplyEventAuthorities(
  reference: SecretReference,
  secrets: SecretResolver,
  configuration: SupplyEventAuthorityConfiguration,
): Promise<readonly LoadedSupplyEventAuthority[]> {
  const bytes = Buffer.from(await secrets.resolve(reference));
  try {
    return parseSupplyEventAuthorityDocument(
      parseJsonObject(bytes, "supply event authority document"),
      configuration,
    );
  } finally {
    bytes.fill(0);
  }
}

export function createSupplyEventCallbackHandlers(
  authorities: readonly LoadedSupplyEventAuthority[],
  dependencies: SupplyEventCallbackDependencies,
): ReadonlyMap<string, GatewayCallbackHandler> {
  const handlers = new Map<string, GatewayCallbackHandler>();
  for (const route of SUPPLY_EVENT_CALLBACK_ROUTES) {
    const routeAuthorities = authorities.filter((authority) => authority.route.routeId === route.routeId);
    if (routeAuthorities.length === 0) throw configurationError(`supply event route ${route.routeId} has no authority`);
    const byProvider = new Map(routeAuthorities.map((authority) => [authority.provider, authority]));
    const integrations = new Map(routeAuthorities.map((authority) => [
      authority.provider,
      new SignedPartnerWebhookIntegration<CapabilityEvidenceBindingTemplate>({
        provider: authority.provider,
        signatureScheme: authority.signatureScheme,
        verificationKeyReference: authority.verificationKeyReference,
        maximumClockSkewSeconds: authority.maximumClockSkewSeconds,
        retentionClass: authority.retentionClass,
        validate(payload, binding) {
          const normalized = normalizeSupplyPayload(route, payload);
          if (normalized.provider !== binding.provider || normalized.subjectId !== binding.subjectId) {
            throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "supply payload does not match its evidence authority/subject");
          }
        },
      }, dependencies.secrets, dependencies.replays, dependencies.artifacts, dependencies.attestor, dependencies.clock),
    ]));
    handlers.set(supplyEventCallbackPath(route.routeId), {
      maximumBodyBytes: Math.max(...routeAuthorities.map((authority) => authority.maximumBodyBytes)),
      async process(request) {
        const unverified = parseJsonObject(request.rawBody, "supply event body");
        const provider = payloadIdentifier(
          requiredString(unverified.provider, "supply provider", 128),
          "supply provider",
        ) as `carrier:${string}` | `vendor:${string}`;
        const authority = byProvider.get(provider);
        const integration = integrations.get(provider);
        if (authority === undefined || integration === undefined) {
          throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "supply event provider is not an enrolled route authority");
        }
        if (request.rawBody.byteLength > authority.maximumBodyBytes) {
          throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "supply event body exceeds its authority limit");
        }
        const subjectId = payloadIdentifier(requiredString(unverified.subjectId, "supply subjectId", 128), "supply subjectId");
        const binding = { ...authority.binding, subjectId } as CapabilityEvidenceBindingTemplate;
        const result = await integration.verifyAndAttestResolvedBusinessEvent({
          binding,
          rawBody: request.rawBody,
          timestamp: requiredHeader(request.headers, "x-ltm-timestamp"),
          nonce: requiredHeader(request.headers, "x-ltm-nonce"),
          signature: requiredHeader(request.headers, "x-ltm-signature"),
        }, (verifiedPayload) => normalizeSupplyPayload(route, verifiedPayload).event);
        return {
          disposition: "attested",
          providerEventId: result.event.eventId,
          evidence: result.evidence,
          businessEvent: result.event,
          receipt: {
            routeId: route.routeId,
            provider,
            subjectId,
            eventType: result.event.eventType,
            artifactSha256: result.evidence.artifactSha256,
          },
        };
      },
    });
  }
  return handlers;
}

export function supplyEventCallbackPath(routeId: SupplyEventRouteId): string {
  return `/v1/callbacks/partners/${routeId}`;
}

function normalizeSupplyPayload(
  route: SupplyEventRouteDefinition,
  value: Readonly<Record<string, unknown>>,
): { readonly provider: string; readonly subjectId: string; readonly event: BusinessEventDraft } {
  const specificKeys = route.batchId === "B99"
    ? ["vendorId", "vendorJobId", "carrierTrackingRef", "locationCode"]
    : route.batchId === "B100"
      ? ["vendorId", "sku", "warehouseId", "quantityDelta", "reservationDelta", "adjustmentReason"]
      : ["projectedFactId"];
  const optionalKeys = route.batchId === "B99" ? ["locationCode"] : route.batchId === "B100" ? ["reservationDelta"] : [];
  assertPayloadKeys(value, [...COMMON_PAYLOAD_KEYS, ...specificKeys], optionalKeys, `supply ${route.routeId} payload`);
  if (value.version !== PAYLOAD_VERSION || value.routeId !== route.routeId) {
    throw responseError(`supply payload must use ${PAYLOAD_VERSION} and route ${route.routeId}`);
  }
  const provider = payloadIdentifier(requiredString(value.provider, "supply provider", 128), "supply provider");
  if (!provider.startsWith(route.providerPrefix) || provider.length === route.providerPrefix.length) {
    throw responseError("supply payload provider does not match its fixed route authority type");
  }
  const eventId = payloadIdentifier(requiredString(value.eventId, "supply eventId", 128), "supply eventId");
  const subjectId = payloadIdentifier(requiredString(value.subjectId, "supply subjectId", 128), "supply subjectId");
  const eventType = payloadIdentifier(requiredString(value.eventType, "supply eventType", 128), "supply eventType");
  const occurredAt = canonicalTimestamp(value.providerOccurredAt, "supply providerOccurredAt");
  const sequence = nullableNonNegativeInteger(value.sequence, "supply sequence");
  let canonicalClaims: JsonObject;
  let correlationId: string;
  if (route.batchId === "B99") {
    if (!SHIPMENT_EVENTS.has(eventType)) throw responseError("shipment eventType is not in the fixed state graph");
    const vendorJobId = fieldIdentifier(value.vendorJobId, "shipment vendorJobId");
    canonicalClaims = {
      vendorId: fieldIdentifier(value.vendorId, "shipment vendorId"),
      vendorJobId,
      carrierTrackingRef: fieldIdentifier(value.carrierTrackingRef, "shipment carrierTrackingRef"),
      ...(value.locationCode === undefined ? {} : { locationCode: fieldIdentifier(value.locationCode, "shipment locationCode") }),
    };
    correlationId = vendorJobId;
  } else if (route.batchId === "B100") {
    if (eventType !== "inventory.adjusted") throw responseError("inventory eventType must be inventory.adjusted");
    const vendorId = fieldIdentifier(value.vendorId, "inventory vendorId");
    if (provider !== `vendor:${vendorId}`) throw responseError("inventory provider does not own the claimed vendor");
    const quantityDelta = boundedInteger(value.quantityDelta, -1_000_000_000, 1_000_000_000, "inventory quantityDelta");
    const reservationDelta = value.reservationDelta === undefined
      ? 0
      : boundedInteger(value.reservationDelta, -1_000_000_000, 1_000_000_000, "inventory reservationDelta");
    if (quantityDelta === 0 && reservationDelta === 0) throw responseError("inventory event must change on-hand or reserved quantity");
    canonicalClaims = {
      vendorId,
      sku: fieldIdentifier(value.sku, "inventory sku"),
      warehouseId: fieldIdentifier(value.warehouseId, "inventory warehouseId"),
      quantityDelta,
      reservationDelta,
      adjustmentReason: fieldIdentifier(value.adjustmentReason, "inventory adjustmentReason"),
    };
    correlationId = subjectId;
  } else {
    if (!SCORECARD_EVENTS.has(eventType)) throw responseError("scorecard eventType is not a projected fact type");
    const vendorId = provider.slice("vendor:".length);
    if (subjectId !== vendorId) throw responseError("scorecard subject does not match its vendor authority");
    const projectedFactId = fieldIdentifier(value.projectedFactId, "scorecard projectedFactId");
    canonicalClaims = { projectedFactId };
    correlationId = projectedFactId;
  }
  return {
    provider,
    subjectId,
    event: {
      eventId,
      subjectType: route.subjectType,
      subjectId,
      eventType,
      providerOccurredAt: occurredAt,
      sequence,
      correlationId,
      canonicalClaims,
    },
  };
}

function assertPayloadKeys(
  value: Readonly<Record<string, unknown>>,
  all: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set(all);
  const optionalSet = new Set(optional);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key)) || all.some((key) => !optionalSet.has(key) && !actual.includes(key))) {
    throw responseError(`${label} has missing or unsupported fields`);
  }
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const set = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !set.has(key))) {
    throw configurationError(`${label} has missing or unsupported fields`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw configurationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function managedReference(value: unknown, label: string): SecretReference {
  const reference = requiredString(value, label, 2_048);
  if (!reference.startsWith("secret-manager:") || reference.length === "secret-manager:".length) {
    throw configurationError(`${label} must use AWS Secrets Manager`);
  }
  return reference as SecretReference;
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw configurationError(`${label} is invalid`);
  return value as T;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw configurationError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw responseError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw responseError(`${label} must be null or a non-negative integer`);
  return value as number;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label, 64);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw responseError(`${label} must be canonical UTC ISO-8601`);
  }
  return timestamp;
}

function fieldIdentifier(value: unknown, label: string): string {
  return payloadIdentifier(requiredString(value, label, 128), label);
}

function payloadIdentifier(value: string, label: string, configuration = false): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || value === "__proto__" || value === "constructor") {
    throw configuration ? configurationError(`${label} is invalid`) : responseError(`${label} is invalid`);
  }
  return value;
}

function requiredHeader(headers: Readonly<Record<string, string>>, name: string): string {
  const value = headers[name];
  if (value === undefined) throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", `${name} header is required`);
  return value;
}

function configurationError(message: string): ProductionIntegrationError {
  return new ProductionIntegrationError("CONFIGURATION_INVALID", message);
}

function responseError(message: string): ProductionIntegrationError {
  return new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", message);
}
