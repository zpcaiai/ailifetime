import { createPrivateKey, X509Certificate } from "node:crypto";
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
  WechatPayEvidenceIntegration,
  parseJsonObject,
  preflightPartnerSignatureKey,
  requiredString,
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
import { ProductionDependencyReadiness } from "./production-readiness.js";
import {
  createExternalCommandPartnerCallbackHandler,
  loadExternalCommandPartnerPolicies,
  partnerCallbackPath,
} from "./partner-callbacks.js";
import {
  createSupplyEventCallbackHandlers,
  loadSupplyEventAuthorities,
} from "./supply-event-callbacks.js";
import {
  createDirectEvidenceCallbackHandlers,
  loadDirectEvidenceAuthorities,
} from "./direct-evidence-callbacks.js";

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
    const policies = await loadExternalCommandPartnerPolicies(configuration.partnerPoliciesReference, secrets, configuration);
    for (const policy of policies) {
      const path = partnerCallbackPath(policy);
      if (routes.has(path)) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner webhook route is duplicated");
      }
      await preflightSignatureKeys(secrets, [[policy.verificationKeyReference, policy.signatureScheme]]);
      routes.set(path, createExternalCommandPartnerCallbackHandler(policy, {
        secrets,
        replays: innerReplays,
        artifacts,
        attestor,
      }));
    }
  }
  if (configuration.supplyEventAuthoritiesReference !== undefined) {
    const authorities = await loadSupplyEventAuthorities(
      configuration.supplyEventAuthoritiesReference,
      secrets,
      configuration,
    );
    await preflightSignatureKeys(secrets, authorities.map((authority) =>
      [authority.verificationKeyReference, authority.signatureScheme] as const));
    for (const [path, handler] of createSupplyEventCallbackHandlers(authorities, {
      secrets,
      replays: innerReplays,
      artifacts,
      attestor,
    })) {
      if (routes.has(path)) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "supply event webhook route is duplicated");
      }
      routes.set(path, handler);
    }
  }
  if (configuration.directEvidenceAuthoritiesReference !== undefined) {
    const authorities = await loadDirectEvidenceAuthorities(
      configuration.directEvidenceAuthoritiesReference,
      secrets,
      configuration,
    );
    await preflightSignatureKeys(secrets, authorities.map((authority) =>
      [authority.verificationKeyReference, authority.signatureScheme] as const));
    for (const [path, handler] of createDirectEvidenceCallbackHandlers(authorities, {
      secrets,
      replays: innerReplays,
      artifacts,
      attestor,
    })) {
      if (routes.has(path)) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "direct evidence webhook route is duplicated");
      }
      routes.set(path, handler);
    }
  }
  const outputTokenProvider = new RotatingFileBearerTokenProvider(configuration.output.bearerTokenFile);
  const evidenceOutput = new ApiExternalBusinessEventOutput({
    endpoint: configuration.output.endpoint,
    purpose: configuration.output.purpose,
  }, outputTokenProvider);
  const productionDependencies = new ProductionDependencyReadiness({
    bucket: configuration.artifactStore.bucket,
    kmsKeyId: configuration.artifactStore.kmsKeyId,
    tenantId: configuration.tenantId,
  }, evidenceOutput);
  return {
    options: {
      tenantId: configuration.tenantId,
      routes,
      evidenceOutput,
      callbackState,
      bodyLimitBytes: configuration.bodyLimitBytes,
      readiness: async () => {
        const dependencies = await productionDependencies.check();
        return {
          ready: callbackState.isReady() && evidenceEnvelopes.isReady() && dependencies.ready,
          checks: {
            callbackState: callbackState.isReady(),
            evidenceEnvelopes: evidenceEnvelopes.isReady(),
            ...dependencies.checks,
            configuration: true,
          },
        };
      },
    },
    close: async () => {
      productionDependencies.close();
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
    await preflightPartnerSignatureKey(reference, scheme, secrets);
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
