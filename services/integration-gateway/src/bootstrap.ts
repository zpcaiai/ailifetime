import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import type { VerifiedBusinessEvent } from "@ltm/core";
import {
  AppleStoreNotificationIntegration,
  AwsSecretsManagerResolver,
  DurableEvidenceAttestor,
  Ed25519EvidenceAttestor,
  GoogleApplicationDefaultAccessTokenProvider,
  GooglePlayEvidenceIntegration,
  GooglePlayRtdnIntegration,
  GooglePubSubOidcVerifier,
  GoogleServiceAccountAccessTokenProvider,
  ProductionIntegrationError,
  RedisCallbackDeliveryStateStore,
  RedisEvidenceEnvelopeStore,
  S3EvidenceArtifactStore,
  SignedCommerceBindingResolver,
  SignedPartnerCommandAdapter,
  SignedPartnerWebhookIntegration,
  WechatPayEvidenceIntegration,
  assertCapabilityEvidenceBinding,
  parseJsonObject,
  requiredString,
  type CapabilityEvidenceBinding,
  type CapabilityEvidenceBindingTemplate,
  type PartnerWebhookSignatureScheme,
  type SecretReference,
  type SignedCapabilityEvidence,
  type WechatPlatformKeyResolver,
} from "@ltm/providers";
import type { IntegrationGatewayConfiguration } from "./config.js";
import type {
  GatewayCallbackHandler,
  GatewayCallbackResult,
  IntegrationGatewayOptions,
} from "./gateway.js";
import { ApiExternalBusinessEventOutput, RotatingFileBearerTokenProvider } from "./evidence-output.js";

export interface BuiltGateway {
  readonly options: IntegrationGatewayOptions;
  close(): Promise<void>;
}

export async function buildIntegrationGateway(configuration: IntegrationGatewayConfiguration): Promise<BuiltGateway> {
  const secrets = new AwsSecretsManagerResolver();
  const callbackState = await RedisCallbackDeliveryStateStore.connect(configuration.redisUrl, {
    allowInsecureLocalhost: configuration.appEnvironment !== "production",
  });
  // The outer durable lease/cache owns callback replay semantics in this process.
  const innerReplays = { claimOnce: async () => true };
  const artifacts = new S3EvidenceArtifactStore(configuration.artifactStore);
  const evidenceEnvelopes = await RedisEvidenceEnvelopeStore.connect(configuration.redisUrl, {
    allowInsecureLocalhost: configuration.appEnvironment !== "production",
  });
  const baseAttestor = new Ed25519EvidenceAttestor({
    ...configuration.attestor,
    replayPolicy: "single_use",
  }, secrets);
  const attestor = new DurableEvidenceAttestor(baseAttestor, evidenceEnvelopes);
  await validateAttestorKey(secrets, configuration.attestor.privateKeyReference);
  const commerceAdapter = new SignedPartnerCommandAdapter({
    endpoint: configuration.commerceBinding.endpoint,
    signingSecretReference: configuration.commerceBinding.signingSecretReference,
    responseVerificationKeyReference: configuration.commerceBinding.responseVerificationKeyReference,
    responseSignatureScheme: configuration.commerceBinding.responseSignatureScheme,
  }, secrets);
  const commerceBindings = new SignedCommerceBindingResolver(commerceAdapter);
  await preflightSignatureKeys(secrets, [
    [configuration.commerceBinding.signingSecretReference, "hmac-sha256"],
    [configuration.commerceBinding.responseVerificationKeyReference, configuration.commerceBinding.responseSignatureScheme],
  ]);
  const routes = new Map<string, GatewayCallbackHandler>();
  if (configuration.apple !== undefined) {
    await validateAppleRoots(secrets, configuration.apple.rootCertificateReferences);
    const integration = new AppleStoreNotificationIntegration({
      bundleId: configuration.apple.bundleId,
      ...(configuration.apple.appAppleId === undefined ? {} : { appAppleId: configuration.apple.appAppleId }),
      appleRootCertificateReferences: configuration.apple.rootCertificateReferences,
      enableOnlineCertificateChecks: configuration.apple.enableOnlineCertificateChecks,
    }, secrets, innerReplays, artifacts, attestor, commerceBindings);
    routes.set("/v1/callbacks/apple", {
      maximumBodyBytes: 1_048_576,
      async process(request) {
        const result = await integration.verifyAndAttest({
          tenantId: configuration.tenantId,
          environment: configuration.evidenceEnvironment,
          rawBody: request.rawBody,
        });
        return result.disposition === "ignored"
          ? { disposition: "ignored", providerEventId: result.notificationId }
          : attested(result.notificationId, result.evidence, result.businessEvent, result.receipt);
      },
    });
  }
  if (configuration.google !== undefined) {
    const tokenProvider = configuration.google.authMode === "adc"
      ? new GoogleApplicationDefaultAccessTokenProvider()
      : new GoogleServiceAccountAccessTokenProvider(
          requiredConfiguredReference(configuration.google.serviceAccountCredentialReference),
          secrets,
        );
    const purchaseIntegration = new GooglePlayEvidenceIntegration(
      { packageName: configuration.google.packageName },
      tokenProvider,
      artifacts,
      attestor,
    );
    const integration = new GooglePlayRtdnIntegration(
      { packageName: configuration.google.packageName, subscription: configuration.google.subscription },
      new GooglePubSubOidcVerifier({
        audience: configuration.google.pushAudience,
        serviceAccountEmail: configuration.google.pushServiceAccountEmail,
      }),
      purchaseIntegration,
      innerReplays,
      artifacts,
      commerceBindings,
    );
    routes.set("/v1/callbacks/google-play", {
      maximumBodyBytes: 1_048_576,
      async process(request) {
        const result = await integration.verifyAndAttest({
          tenantId: configuration.tenantId,
          environment: configuration.evidenceEnvironment,
          authorization: header(request.headers, "authorization"),
          rawBody: request.rawBody,
        });
        return result.disposition === "ignored"
          ? { disposition: "ignored", providerEventId: result.messageId }
          : attested(result.messageId, result.evidence, result.businessEvent, result.receipt);
      },
    });
  }
  if (configuration.wechat !== undefined) {
    const platformKeys = await ManagedWechatPlatformKeyResolver.create(
      configuration.wechat.platformKeyMapReference,
      secrets,
    );
    const integration = new WechatPayEvidenceIntegration({
      merchantId: configuration.wechat.merchantId,
      apiV3KeyReference: configuration.wechat.apiV3KeyReference,
    }, secrets, platformKeys, innerReplays, artifacts, attestor, commerceBindings);
    routes.set("/v1/callbacks/wechat-pay", {
      maximumBodyBytes: 1_048_576,
      async process(request) {
        const result = await integration.verifyAndAttest({
          tenantId: configuration.tenantId,
          environment: configuration.evidenceEnvironment,
          headers: {
            timestamp: header(request.headers, "wechatpay-timestamp"),
            nonce: header(request.headers, "wechatpay-nonce"),
            serial: header(request.headers, "wechatpay-serial"),
            signature: header(request.headers, "wechatpay-signature"),
          },
          rawBody: request.rawBody,
        });
        return attested(result.receipt.eventId, result.evidence, result.businessEvent, result.receipt);
      },
    });
  }
  if (configuration.partnerPoliciesReference !== undefined) {
    const policies = await loadPartnerPolicies(configuration.partnerPoliciesReference, secrets, configuration);
    for (const policy of policies) {
      if (routes.has(`/v1/callbacks/partners/${policy.routeId}`)) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner webhook route is duplicated");
      }
      await preflightSignatureKeys(secrets, [[policy.verificationKeyReference, policy.signatureScheme]]);
      const integration = new SignedPartnerWebhookIntegration<CapabilityEvidenceBindingTemplate>({
        provider: policy.binding.provider,
        signatureScheme: policy.signatureScheme,
        verificationKeyReference: policy.verificationKeyReference,
        maximumClockSkewSeconds: policy.maximumClockSkewSeconds,
        retentionClass: policy.retentionClass,
        validate(payload, binding) {
          validatePartnerPayload(policy, payload, binding.subjectId);
        },
      }, secrets, innerReplays, artifacts, attestor);
      routes.set(`/v1/callbacks/partners/${policy.routeId}`, {
        maximumBodyBytes: policy.maximumBodyBytes,
        async process(request) {
          const payload = parseJsonObject(request.rawBody, "partner webhook body");
          const subjectId = requiredString(pathValue(payload, policy.subjectField), "partner subject", 128);
          const businessDraft = partnerBusinessEventDraft(policy, payload);
          const attestedEvent = await integration.verifyAndAttestBusinessEvent({
            binding: { ...policy.binding, subjectId },
            rawBody: request.rawBody,
            timestamp: header(request.headers, "x-ltm-timestamp"),
            nonce: header(request.headers, "x-ltm-nonce"),
            signature: header(request.headers, "x-ltm-signature"),
          }, businessDraft);
          return attested(businessDraft.eventId, attestedEvent.evidence, attestedEvent.event, {
            routeId: policy.routeId,
            provider: policy.binding.provider,
            subjectId,
            artifactSha256: attestedEvent.evidence.artifactSha256,
          });
        },
      });
    }
  }
  const outputTokenProvider = new RotatingFileBearerTokenProvider(configuration.output.bearerTokenFile);
  const evidenceOutput = new ApiExternalBusinessEventOutput({
    endpoint: configuration.output.endpoint,
    purpose: configuration.output.purpose,
  }, outputTokenProvider);
  return {
    options: {
      tenantId: configuration.tenantId,
      routes,
      evidenceOutput,
      callbackState,
      bodyLimitBytes: configuration.bodyLimitBytes,
      readiness: async () => {
        let apiIdentity = false;
        try {
          await outputTokenProvider.getToken();
          apiIdentity = true;
        } catch {
          apiIdentity = false;
        }
        return {
          ready: callbackState.isReady() && evidenceEnvelopes.isReady() && apiIdentity,
          checks: {
            callbackState: callbackState.isReady(),
            evidenceEnvelopes: evidenceEnvelopes.isReady(),
            apiWorkloadIdentity: apiIdentity,
            configuration: true,
          },
        };
      },
    },
    close: async () => {
      await Promise.all([callbackState.close(), evidenceEnvelopes.close()]);
    },
  };
}

function attested(
  providerEventId: string,
  evidence: SignedCapabilityEvidence,
  businessEvent: VerifiedBusinessEvent,
  receipt: object,
): GatewayCallbackResult {
  return {
    disposition: "attested",
    providerEventId,
    evidence,
    businessEvent,
    receipt: receipt as Readonly<Record<string, unknown>>,
  };
}

class ManagedWechatPlatformKeyResolver implements WechatPlatformKeyResolver {
  private constructor(
    private readonly references: ReadonlyMap<string, SecretReference>,
    private readonly secrets: AwsSecretsManagerResolver,
  ) {}

  static async create(reference: SecretReference, secrets: AwsSecretsManagerResolver): Promise<ManagedWechatPlatformKeyResolver> {
    const bytes = Buffer.from(await secrets.resolve(reference));
    try {
      const payload = parseJsonObject(bytes, "WeChat platform key map");
      if (Object.keys(payload).length === 0 || Object.keys(payload).length > 32) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat platform key map must contain one to 32 serials");
      }
      const references = new Map<string, SecretReference>();
      for (const [serial, value] of Object.entries(payload)) {
        if (!/^[A-Za-z0-9]{8,128}$/.test(serial)) {
          throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat platform certificate serial is invalid");
        }
        const keyReference = managedReference(value, "WeChat platform key reference");
        references.set(serial, keyReference);
      }
      return new ManagedWechatPlatformKeyResolver(references, secrets);
    } finally {
      bytes.fill(0);
    }
  }

  async resolve(serial: string): Promise<Buffer> {
    const reference = this.references.get(serial);
    if (reference === undefined) {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "WeChat platform certificate serial is not configured", true);
    }
    return Buffer.from(await this.secrets.resolve(reference));
  }
}

interface LoadedPartnerPolicy {
  readonly routeId: string;
  readonly binding: CapabilityEvidenceBindingTemplate;
  readonly signatureScheme: PartnerWebhookSignatureScheme;
  readonly verificationKeyReference: SecretReference;
  readonly maximumClockSkewSeconds: number;
  readonly maximumBodyBytes: number;
  readonly retentionClass: "financial" | "release" | "operational";
  readonly subjectField: string;
  readonly requiredFields: readonly string[];
  readonly stateField?: string;
  readonly allowedStates?: readonly string[];
  readonly eventIdField: string;
  readonly eventTypeField: string;
  readonly eventTypeMap: Readonly<Record<string, string>>;
  readonly subjectType: string;
  readonly providerOccurredAtField: string;
  readonly correlationIdField: string;
  readonly sequenceField?: string;
  readonly canonicalClaimFields: Readonly<Record<string, string>>;
}

async function loadPartnerPolicies(
  reference: SecretReference,
  secrets: AwsSecretsManagerResolver,
  configuration: IntegrationGatewayConfiguration,
): Promise<readonly LoadedPartnerPolicy[]> {
  const bytes = Buffer.from(await secrets.resolve(reference));
  try {
    const payload = parseJsonObject(bytes, "partner webhook policy document");
    if (payload.version !== "ltm.partner-webhook-policies.v1" || !Array.isArray(payload.routes) ||
        payload.routes.length === 0 || payload.routes.length > 64) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner webhook policy document is invalid");
    }
    const seen = new Set<string>();
    return payload.routes.map((value) => {
      const record = objectValue(value, "partner webhook route");
      const routeId = token(requiredString(record.routeId, "partner routeId", 64), "partner routeId");
      if (seen.has(routeId)) throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner routeId is duplicated");
      seen.add(routeId);
      const binding = {
        tenantId: configuration.tenantId,
        batchId: requiredString(record.batchId, "partner batchId", 16),
        operation: requiredString(record.operation, "partner operation", 160),
        kind: requiredString(record.kind, "partner kind", 160),
        provider: requiredString(record.provider, "partner provider", 128),
        environment: configuration.evidenceEnvironment,
        subjectId: "configuration-check",
      } as unknown as CapabilityEvidenceBindingTemplate;
      try {
        assertCapabilityEvidenceBinding({ ...binding, artifactSha256: "0".repeat(64) } as CapabilityEvidenceBinding);
      } catch {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", `partner route ${routeId} has an unsupported evidence tuple`);
      }
      const eventContract = businessEventContract(binding.batchId, binding.operation);
      const requiredFields = stringArray(record.requiredFields, "partner requiredFields", 64);
      const stateField = optionalString(record.stateField, "partner stateField", 256);
      const allowedStates = record.allowedStates === undefined
        ? undefined
        : stringArray(record.allowedStates, "partner allowedStates", 64);
      if ((stateField === undefined) !== (allowedStates === undefined)) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner stateField and allowedStates are required together");
      }
      const eventTypeMapValue = objectValue(record.eventTypeMap, "partner eventTypeMap");
      const eventTypeMap: Record<string, string> = {};
      for (const [nativeType, canonicalTypeValue] of Object.entries(eventTypeMapValue)) {
        const native = token(nativeType, "partner native event type");
        const canonical = token(requiredString(canonicalTypeValue, "partner canonical event type", 128), "partner canonical event type");
        if (!eventContract.eventTypes.includes(canonical)) {
          throw new ProductionIntegrationError("CONFIGURATION_INVALID", `partner route ${routeId} maps an unsupported business event type`);
        }
        eventTypeMap[native] = canonical;
      }
      if (Object.keys(eventTypeMap).length === 0 || Object.keys(eventTypeMap).length > 64) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner eventTypeMap must be non-empty and bounded");
      }
      const claimFieldsValue = objectValue(record.canonicalClaimFields, "partner canonicalClaimFields");
      const canonicalClaimFields: Record<string, string> = {};
      for (const [claimName, fieldPathValue] of Object.entries(claimFieldsValue)) {
        if (!eventContract.claims.includes(claimName)) {
          throw new ProductionIntegrationError("CONFIGURATION_INVALID", `partner route ${routeId} maps a non-permitted canonical claim`);
        }
        canonicalClaimFields[token(claimName, "partner canonical claim name")] = jsonPath(
          requiredString(fieldPathValue, "partner canonical claim field", 256),
        );
      }
      if (Object.keys(canonicalClaimFields).length === 0) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner canonicalClaimFields must be non-empty");
      }
      const subjectType = token(requiredString(record.subjectType, "partner subjectType", 128), "partner subjectType");
      if (subjectType !== eventContract.subjectType) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", `partner route ${routeId} subjectType does not match its capability contract`);
      }
      const sequenceField = optionalString(record.sequenceField, "partner sequenceField", 256);
      return {
        routeId,
        binding,
        signatureScheme: enumValue(record.signatureScheme, "partner signatureScheme", ["hmac-sha256", "ed25519", "es256"] as const),
        verificationKeyReference: managedReference(record.verificationKeyReference, "partner verificationKeyReference"),
        maximumClockSkewSeconds: integerValue(record.maximumClockSkewSeconds, 300, 30, 900, "partner maximumClockSkewSeconds"),
        maximumBodyBytes: integerValue(record.maximumBodyBytes, 1_048_576, 1_024, 10_485_760, "partner maximumBodyBytes"),
        retentionClass: enumValue(record.retentionClass, "partner retentionClass", ["financial", "release", "operational"] as const),
        subjectField: jsonPath(requiredString(record.subjectField, "partner subjectField", 256)),
        requiredFields: requiredFields.map(jsonPath),
        eventIdField: jsonPath(requiredString(record.eventIdField, "partner eventIdField", 256)),
        eventTypeField: jsonPath(requiredString(record.eventTypeField, "partner eventTypeField", 256)),
        eventTypeMap,
        subjectType,
        providerOccurredAtField: jsonPath(requiredString(record.providerOccurredAtField, "partner providerOccurredAtField", 256)),
        correlationIdField: jsonPath(requiredString(record.correlationIdField, "partner correlationIdField", 256)),
        ...(sequenceField === undefined ? {} : { sequenceField: jsonPath(sequenceField) }),
        canonicalClaimFields,
        ...(stateField === undefined || allowedStates === undefined
          ? {}
          : { stateField: jsonPath(stateField), allowedStates }),
      };
    });
  } finally {
    bytes.fill(0);
  }
}

interface PartnerBusinessEventContract {
  readonly subjectType: string;
  readonly eventTypes: readonly string[];
  readonly claims: readonly string[];
}

function businessEventContract(batchId: string, operation: string): PartnerBusinessEventContract {
  const key = `${batchId}:${operation}`;
  const contracts: Readonly<Record<string, PartnerBusinessEventContract>> = {
    "B74:scheduleMultiChannelNotification": {
      subjectType: "notification",
      eventTypes: ["notification.acknowledged", "notification.delivered", "notification.failed", "notification.suppressed"],
      claims: ["providerOperationId"],
    },
    "B89:requestTaxDocument": {
      subjectType: "tax-document",
      eventTypes: ["tax-document.acknowledged", "tax-document.issued", "tax-document.rejected", "tax-document.reissue", "tax-document.red_letter"],
      claims: ["providerOperationId"],
    },
    "B98:createVendorProductionJob": {
      subjectType: "vendor-job",
      eventTypes: ["vendor-job.accepted", "vendor-job.rejected", "vendor-job.scheduled", "vendor-job.production", "vendor-job.qc", "vendor-job.shipped", "vendor-job.failed"],
      claims: ["providerOperationId", "vendorId"],
    },
    "B99:recordShipment": {
      subjectType: "shipment",
      eventTypes: ["shipment.label_created", "shipment.picked_up", "shipment.in_transit", "shipment.delayed", "shipment.out_for_delivery", "shipment.delivered", "shipment.exception", "shipment.returned", "shipment.cancelled"],
      claims: ["carrierTrackingRef", "locationCode", "vendorId", "vendorJobId", "onTime"],
    },
    "B100:recordInventoryAdjustment": {
      subjectType: "inventory-item",
      eventTypes: ["inventory.adjusted"],
      claims: ["vendorId", "sku", "warehouseId", "quantityDelta", "reservationDelta", "adjustmentReason"],
    },
    "B101:createReturnOrClaim": {
      subjectType: "return-claim",
      eventTypes: ["return-claim.eligible", "return-claim.accepted", "return-claim.in_transit", "return-claim.refunded", "return-claim.replaced", "return-claim.recovered", "return-claim.denied"],
      claims: ["providerOperationId", "vendorId"],
    },
    "B102:publishVendorScorecard": {
      subjectType: "vendor",
      eventTypes: ["scorecard.vendor_job", "scorecard.shipment", "scorecard.claim", "scorecard.settlement"],
      claims: ["projectedFactId"],
    },
  };
  const contract = contracts[key];
  if (contract === undefined) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner webhook route is not an atomic external business event capability");
  }
  return contract;
}

function partnerBusinessEventDraft(
  policy: LoadedPartnerPolicy,
  payload: Readonly<Record<string, unknown>>,
): Pick<VerifiedBusinessEvent, "eventId" | "subjectType" | "subjectId" | "eventType" | "providerOccurredAt" | "sequence" | "correlationId" | "canonicalClaims"> {
  const eventId = token(requiredString(pathValue(payload, policy.eventIdField), "partner eventId", 128), "partner eventId");
  const subjectId = token(requiredString(pathValue(payload, policy.subjectField), "partner subjectId", 128), "partner subjectId");
  const nativeEventType = token(requiredString(pathValue(payload, policy.eventTypeField), "partner eventType", 128), "partner eventType");
  const eventType = policy.eventTypeMap[nativeEventType];
  if (eventType === undefined) {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "partner event type is not allowlisted by route policy");
  }
  const occurredValue = requiredString(pathValue(payload, policy.providerOccurredAtField), "partner providerOccurredAt", 64);
  const occurredMilliseconds = Date.parse(occurredValue);
  if (!Number.isFinite(occurredMilliseconds)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner providerOccurredAt is invalid");
  }
  const canonicalClaims: Record<string, import("@ltm/core").JsonValue> = {};
  for (const [claimName, path] of Object.entries(policy.canonicalClaimFields)) {
    const value = pathValue(payload, path);
    if (value === undefined) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `partner canonical claim ${claimName} is missing`);
    }
    canonicalClaims[claimName] = value as import("@ltm/core").JsonValue;
  }
  const sequenceValue = policy.sequenceField === undefined ? null : pathValue(payload, policy.sequenceField);
  if (sequenceValue !== null && (!Number.isSafeInteger(sequenceValue) || (sequenceValue as number) < 0)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner sequence must be null or a non-negative integer");
  }
  return {
    eventId,
    subjectType: policy.subjectType,
    subjectId,
    eventType,
    providerOccurredAt: new Date(occurredMilliseconds).toISOString(),
    sequence: sequenceValue as number | null,
    correlationId: token(
      requiredString(pathValue(payload, policy.correlationIdField), "partner correlationId", 128),
      "partner correlationId",
    ),
    canonicalClaims,
  };
}

function validatePartnerPayload(
  policy: LoadedPartnerPolicy,
  payload: Readonly<Record<string, unknown>>,
  subjectId: string,
): void {
  if (pathValue(payload, policy.subjectField) !== subjectId) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner payload subject does not match its evidence binding");
  }
  for (const path of policy.requiredFields) {
    if (pathValue(payload, path) === undefined) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `partner payload is missing required field ${path}`);
    }
  }
  if (policy.stateField !== undefined && policy.allowedStates !== undefined) {
    const state = pathValue(payload, policy.stateField);
    if (typeof state !== "string" || !policy.allowedStates.includes(state)) {
      throw new ProductionIntegrationError("PROVIDER_REJECTED", "partner payload state is not allowed");
    }
  }
}

async function validateAttestorKey(secrets: AwsSecretsManagerResolver, reference: SecretReference): Promise<void> {
  const bytes = Buffer.from(await secrets.resolve(reference));
  try {
    if (createPrivateKey(bytes).asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence signing key must be Ed25519");
  } finally {
    bytes.fill(0);
  }
}

async function validateAppleRoots(secrets: AwsSecretsManagerResolver, references: readonly SecretReference[]): Promise<void> {
  for (const reference of references) {
    const bytes = Buffer.from(await secrets.resolve(reference));
    try {
      new X509Certificate(bytes);
    } catch {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Apple root certificate secret is not a valid certificate");
    } finally {
      bytes.fill(0);
    }
  }
}

async function preflightSignatureKeys(
  secrets: AwsSecretsManagerResolver,
  inputs: readonly (readonly [SecretReference, PartnerWebhookSignatureScheme])[],
): Promise<void> {
  for (const [reference, scheme] of inputs) {
    const bytes = Buffer.from(await secrets.resolve(reference));
    try {
      if (scheme === "hmac-sha256") {
        if (bytes.byteLength < 32) throw new Error("short key");
      } else {
        const key = createPublicKey(bytes);
        if ((scheme === "ed25519" && key.asymmetricKeyType !== "ed25519") ||
            (scheme === "es256" && key.asymmetricKeyType !== "ec")) throw new Error("wrong key type");
      }
    } catch {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "configured signature key is invalid");
    } finally {
      bytes.fill(0);
    }
  }
}

function requiredConfiguredReference(value: SecretReference | undefined): SecretReference {
  if (value === undefined) throw new ProductionIntegrationError("CONFIGURATION_INVALID", "managed Google credential reference is missing");
  return value;
}

function managedReference(value: unknown, label: string): SecretReference {
  const reference = requiredString(value, label, 2_048);
  if (!reference.startsWith("secret-manager:") || reference.length === "secret-manager:".length) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${label} must use AWS Secrets Manager`);
  }
  return reference as SecretReference;
}

function header(headers: Readonly<Record<string, string>>, name: string): string {
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

function jsonPath(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,5}$/.test(value)) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner JSON field path is invalid");
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum ||
      value.some((item) => typeof item !== "string") || new Set(value).size !== value.length) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${label} must be a bounded unique string array`);
  }
  return value as string[];
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, label, maximum);
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < minimum || (resolved as number) > maximum) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return resolved as number;
}

function token(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return value as T;
}
