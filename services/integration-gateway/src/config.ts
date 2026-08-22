import {
  ProductionIntegrationError,
  assertProductionEndpoint,
  type EvidenceEnvironment,
  type PartnerWebhookSignatureScheme,
  type SecretReference,
} from "@ltm/providers";

export type GatewayEnvironment = "test" | "sandbox" | "staging" | "production";

export interface GatewayAppleConfiguration {
  readonly bundleId: string;
  readonly appAppleId?: number;
  readonly rootCertificateReferences: readonly SecretReference[];
  readonly enableOnlineCertificateChecks: boolean;
}

export interface GatewayGoogleConfiguration {
  readonly packageName: string;
  readonly authMode: "adc" | "managed-service-account";
  readonly serviceAccountCredentialReference?: SecretReference;
  readonly pushAudience: string;
  readonly pushServiceAccountEmail: string;
  readonly subscription: string;
}

export interface GatewayWechatConfiguration {
  readonly merchantId: string;
  readonly apiV3KeyReference: SecretReference;
  /** Secret JSON maps platform certificate serials to managed secret references. */
  readonly platformKeyMapReference: SecretReference;
}

export interface IntegrationGatewayConfiguration {
  readonly appEnvironment: GatewayEnvironment;
  readonly evidenceEnvironment: EvidenceEnvironment;
  readonly tenantId: string;
  readonly host: string;
  readonly port: number;
  readonly bodyLimitBytes: number;
  readonly redisUrl: string;
  readonly artifactStore: {
    readonly bucket: string;
    readonly keyPrefix: string;
    readonly kmsKeyId: string;
    readonly retentionDays: Readonly<Record<"financial" | "release" | "operational", number>>;
  };
  readonly attestor: {
    readonly issuer: string;
    readonly keyId: string;
    readonly privateKeyReference: SecretReference;
    readonly lifetimeMs: number;
  };
  readonly output: {
    readonly endpoint: URL;
    readonly bearerTokenFile: string;
    readonly purpose: string;
  };
  readonly commerceBinding: {
    readonly endpoint: URL;
    readonly signingSecretReference: SecretReference;
    readonly responseVerificationKeyReference: SecretReference;
    readonly responseSignatureScheme: PartnerWebhookSignatureScheme;
  };
  readonly apple?: GatewayAppleConfiguration;
  readonly google?: GatewayGoogleConfiguration;
  readonly wechat?: GatewayWechatConfiguration;
  readonly partnerPoliciesReference?: SecretReference;
}

const FORBIDDEN_INLINE_SECRETS = [
  "LTM_EVIDENCE_PRIVATE_KEY",
  "LTM_EVIDENCE_PRIVATE_KEY_PEM",
  "LTM_EVIDENCE_SINK_SIGNING_KEY",
  "LTM_EVIDENCE_SINK_RESPONSE_KEY",
  "LTM_GOOGLE_SERVICE_ACCOUNT_JSON",
  "LTM_WECHAT_API_V3_KEY",
  "LTM_WECHAT_PLATFORM_CERTIFICATES_JSON",
  "LTM_APPLE_ROOT_CERTIFICATES_PEM",
  "LTM_API_BEARER_TOKEN",
] as const;

export function loadIntegrationGatewayConfiguration(environment: NodeJS.ProcessEnv): IntegrationGatewayConfiguration {
  for (const name of FORBIDDEN_INLINE_SECRETS) {
    if ((environment[name]?.trim().length ?? 0) > 0) {
      throw configError(`${name} is forbidden; use an AWS Secrets Manager reference`);
    }
  }
  const appEnvironment = enumValue(
    required(environment.APP_ENV, "APP_ENV", 32).toLowerCase(),
    "APP_ENV",
    ["test", "sandbox", "staging", "production"] as const,
  );
  const tenantId = token(required(environment.LTM_TENANT_ID, "LTM_TENANT_ID", 128), "LTM_TENANT_ID");
  const redisUrl = required(environment.LTM_REDIS_URL, "LTM_REDIS_URL", 2_048);
  validateRedisUrl(redisUrl, appEnvironment);
  const issuer = token(required(environment.LTM_EVIDENCE_ISSUER, "LTM_EVIDENCE_ISSUER", 128), "LTM_EVIDENCE_ISSUER");
  if (appEnvironment === "production" && /^(?:test|sandbox|fixture)(?::|$)/.test(issuer)) {
    throw configError("production gateway cannot use a test, sandbox, or fixture evidence issuer");
  }
  const outputEndpoint = parseUrl(required(environment.LTM_API_COMMAND_URL, "LTM_API_COMMAND_URL", 2_048));
  assertProductionEndpoint(outputEndpoint);
  if (outputEndpoint.pathname !== "/v1/commands" || outputEndpoint.search !== "") {
    throw configError("LTM_API_COMMAND_URL must use the exact /v1/commands path");
  }
  const commerceBindingEndpoint = parseUrl(required(
    environment.LTM_COMMERCE_BINDING_URL,
    "LTM_COMMERCE_BINDING_URL",
    2_048,
  ));
  assertProductionEndpoint(commerceBindingEndpoint);
  const appleEnabled = booleanValue(environment.LTM_APPLE_CALLBACKS_ENABLED, "LTM_APPLE_CALLBACKS_ENABLED");
  const googleEnabled = booleanValue(environment.LTM_GOOGLE_CALLBACKS_ENABLED, "LTM_GOOGLE_CALLBACKS_ENABLED");
  const wechatEnabled = booleanValue(environment.LTM_WECHAT_CALLBACKS_ENABLED, "LTM_WECHAT_CALLBACKS_ENABLED");
  const partnerPoliciesReference = optionalSecretReference(environment.LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE);
  if (!appleEnabled && !googleEnabled && !wechatEnabled && partnerPoliciesReference === undefined) {
    throw configError("at least one provider callback or partner policy reference must be configured");
  }
  const apple = appleEnabled ? appleConfiguration(environment, appEnvironment) : undefined;
  const google = googleEnabled ? googleConfiguration(environment) : undefined;
  const wechat = wechatEnabled ? wechatConfiguration(environment) : undefined;
  return {
    appEnvironment,
    evidenceEnvironment: appEnvironment,
    tenantId,
    host: required(environment.HOST ?? "0.0.0.0", "HOST", 255),
    port: integerValue(environment.PORT, 8_081, 1, 65_535, "PORT"),
    bodyLimitBytes: integerValue(environment.LTM_GATEWAY_BODY_LIMIT_BYTES, 1_048_576, 1_024, 10_485_760, "LTM_GATEWAY_BODY_LIMIT_BYTES"),
    redisUrl,
    artifactStore: {
      bucket: required(environment.LTM_EVIDENCE_S3_BUCKET, "LTM_EVIDENCE_S3_BUCKET", 63),
      keyPrefix: required(environment.LTM_EVIDENCE_S3_PREFIX ?? "ltm/provider-evidence", "LTM_EVIDENCE_S3_PREFIX", 256),
      kmsKeyId: required(environment.LTM_EVIDENCE_S3_KMS_KEY_ID, "LTM_EVIDENCE_S3_KMS_KEY_ID", 2_048),
      retentionDays: {
        financial: integerValue(environment.LTM_EVIDENCE_FINANCIAL_RETENTION_DAYS, 2_555, 1, 3_650, "LTM_EVIDENCE_FINANCIAL_RETENTION_DAYS"),
        release: integerValue(environment.LTM_EVIDENCE_RELEASE_RETENTION_DAYS, 2_555, 1, 3_650, "LTM_EVIDENCE_RELEASE_RETENTION_DAYS"),
        operational: integerValue(environment.LTM_EVIDENCE_OPERATIONAL_RETENTION_DAYS, 365, 1, 3_650, "LTM_EVIDENCE_OPERATIONAL_RETENTION_DAYS"),
      },
    },
    attestor: {
      issuer,
      keyId: token(required(environment.LTM_EVIDENCE_KEY_ID, "LTM_EVIDENCE_KEY_ID", 128), "LTM_EVIDENCE_KEY_ID"),
      privateKeyReference: secretReference(environment.LTM_EVIDENCE_PRIVATE_KEY_REFERENCE, "LTM_EVIDENCE_PRIVATE_KEY_REFERENCE"),
      lifetimeMs: integerValue(environment.LTM_EVIDENCE_LIFETIME_MS, 900_000, 60_000, 86_400_000, "LTM_EVIDENCE_LIFETIME_MS"),
    },
    output: {
      endpoint: outputEndpoint,
      bearerTokenFile: absolutePath(required(environment.LTM_API_BEARER_TOKEN_FILE, "LTM_API_BEARER_TOKEN_FILE", 4_096)),
      purpose: token(environment.LTM_API_EVIDENCE_PURPOSE?.trim() || "external_business_event_projection", "LTM_API_EVIDENCE_PURPOSE"),
    },
    commerceBinding: {
      endpoint: commerceBindingEndpoint,
      signingSecretReference: secretReference(
        environment.LTM_COMMERCE_BINDING_SIGNING_KEY_REFERENCE,
        "LTM_COMMERCE_BINDING_SIGNING_KEY_REFERENCE",
      ),
      responseVerificationKeyReference: secretReference(
        environment.LTM_COMMERCE_BINDING_RESPONSE_KEY_REFERENCE,
        "LTM_COMMERCE_BINDING_RESPONSE_KEY_REFERENCE",
      ),
      responseSignatureScheme: enumValue(
        required(environment.LTM_COMMERCE_BINDING_RESPONSE_SIGNATURE_SCHEME, "LTM_COMMERCE_BINDING_RESPONSE_SIGNATURE_SCHEME", 32),
        "LTM_COMMERCE_BINDING_RESPONSE_SIGNATURE_SCHEME",
        ["hmac-sha256", "ed25519", "es256"] as const,
      ),
    },
    ...(apple === undefined ? {} : { apple }),
    ...(google === undefined ? {} : { google }),
    ...(wechat === undefined ? {} : { wechat }),
    ...(partnerPoliciesReference === undefined ? {} : { partnerPoliciesReference }),
  };
}

function appleConfiguration(environment: NodeJS.ProcessEnv, appEnvironment: GatewayEnvironment): GatewayAppleConfiguration {
  const references = commaList(
    required(environment.LTM_APPLE_ROOT_CERTIFICATE_REFERENCES, "LTM_APPLE_ROOT_CERTIFICATE_REFERENCES", 8_192),
    "LTM_APPLE_ROOT_CERTIFICATE_REFERENCES",
    8,
  ).map((value) => exactSecretReference(value, "LTM_APPLE_ROOT_CERTIFICATE_REFERENCES"));
  const online = booleanValue(environment.LTM_APPLE_ONLINE_CERTIFICATE_CHECKS, "LTM_APPLE_ONLINE_CERTIFICATE_CHECKS");
  const appAppleId = optionalInteger(environment.LTM_APPLE_APP_ID, 1, Number.MAX_SAFE_INTEGER, "LTM_APPLE_APP_ID");
  if (appEnvironment === "production" && (!online || appAppleId === undefined)) {
    throw configError("production Apple callbacks require online certificate checks and LTM_APPLE_APP_ID");
  }
  return {
    bundleId: required(environment.LTM_APPLE_BUNDLE_ID, "LTM_APPLE_BUNDLE_ID", 255),
    rootCertificateReferences: references,
    enableOnlineCertificateChecks: online,
    ...(appAppleId === undefined ? {} : { appAppleId }),
  };
}

function googleConfiguration(environment: NodeJS.ProcessEnv): GatewayGoogleConfiguration {
  const audience = required(environment.LTM_GOOGLE_PUBSUB_AUDIENCE, "LTM_GOOGLE_PUBSUB_AUDIENCE", 2_048);
  assertProductionEndpoint(parseUrl(audience));
  const authMode = enumValue(
    environment.LTM_GOOGLE_AUTH_MODE?.trim() || "adc",
    "LTM_GOOGLE_AUTH_MODE",
    ["adc", "managed-service-account"] as const,
  );
  const serviceAccountCredentialReference = authMode === "managed-service-account"
    ? secretReference(environment.LTM_GOOGLE_SERVICE_ACCOUNT_REFERENCE, "LTM_GOOGLE_SERVICE_ACCOUNT_REFERENCE")
    : undefined;
  if (authMode === "adc" && (environment.LTM_GOOGLE_SERVICE_ACCOUNT_REFERENCE?.trim().length ?? 0) > 0) {
    throw configError("LTM_GOOGLE_SERVICE_ACCOUNT_REFERENCE requires LTM_GOOGLE_AUTH_MODE=managed-service-account");
  }
  return {
    packageName: required(environment.LTM_GOOGLE_PLAY_PACKAGE_NAME, "LTM_GOOGLE_PLAY_PACKAGE_NAME", 255),
    authMode,
    ...(serviceAccountCredentialReference === undefined ? {} : { serviceAccountCredentialReference }),
    pushAudience: audience,
    pushServiceAccountEmail: required(environment.LTM_GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL, "LTM_GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL", 320),
    subscription: required(environment.LTM_GOOGLE_PUBSUB_SUBSCRIPTION, "LTM_GOOGLE_PUBSUB_SUBSCRIPTION", 768),
  };
}

function wechatConfiguration(environment: NodeJS.ProcessEnv): GatewayWechatConfiguration {
  return {
    merchantId: token(required(environment.LTM_WECHAT_MERCHANT_ID, "LTM_WECHAT_MERCHANT_ID", 128), "LTM_WECHAT_MERCHANT_ID"),
    apiV3KeyReference: secretReference(environment.LTM_WECHAT_API_V3_KEY_REFERENCE, "LTM_WECHAT_API_V3_KEY_REFERENCE"),
    platformKeyMapReference: secretReference(
      environment.LTM_WECHAT_PLATFORM_KEY_MAP_REFERENCE,
      "LTM_WECHAT_PLATFORM_KEY_MAP_REFERENCE",
    ),
  };
}

function secretReference(value: string | undefined, label: string): SecretReference {
  return exactSecretReference(required(value, label, 2_048), label);
}

function optionalSecretReference(value: string | undefined): SecretReference | undefined {
  return value === undefined || value.trim() === "" ? undefined : exactSecretReference(value.trim(), "managed secret reference");
}

function exactSecretReference(value: string, label: string): SecretReference {
  if (!value.startsWith("secret-manager:") || value.length === "secret-manager:".length || /[\u0000-\u001f\u007f]/.test(value)) {
    throw configError(`${label} must be an AWS Secrets Manager reference`);
  }
  return value as SecretReference;
}

function validateRedisUrl(value: string, appEnvironment: GatewayEnvironment): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError("LTM_REDIS_URL must be a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "rediss:" && !(appEnvironment !== "production" && local && url.protocol === "redis:")) {
    throw configError("Redis must use TLS except for non-production loopback development");
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw configError("configured endpoint must be a URL");
  }
}

function absolutePath(value: string): string {
  if (!value.startsWith("/") || value.includes("\0")) throw configError("LTM_API_BEARER_TOKEN_FILE must be an absolute path");
  return value;
}

function required(value: string | undefined, label: string, maximum: number): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw configError(`${label} is required and must be a bounded visible string`);
  }
  return normalized;
}

function token(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw configError(`${label} is invalid`);
  return value;
}

function booleanValue(value: string | undefined, label: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw configError(`${label} must be true or false`);
}

function integerValue(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  return integerUnknown(value, minimum, maximum, label);
}

function optionalInteger(value: string | undefined, minimum: number, maximum: number, label: string): number | undefined {
  return value === undefined || value.trim() === "" ? undefined : integerUnknown(value, minimum, maximum, label);
}

function integerUnknown(value: string, minimum: number, maximum: number, label: string): number {
  if (!/^\d+$/.test(value)) throw configError(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function commaList(value: string, label: string, maximum: number): readonly string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > maximum || new Set(entries).size !== entries.length) {
    throw configError(`${label} must be a non-empty unique list of at most ${maximum} values`);
  }
  return entries;
}

function enumValue<T extends string>(value: string, label: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw configError(`${label} is invalid`);
  return value as T;
}

function configError(message: string): ProductionIntegrationError {
  return new ProductionIntegrationError("CONFIGURATION_INVALID", message);
}
