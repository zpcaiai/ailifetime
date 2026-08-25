import { isAbsolute } from "node:path";
import { configuration } from "./contracts.js";

export interface BrokerConfiguration {
  readonly appEnvironment: "test" | "development" | "staging" | "production";
  readonly host: string;
  readonly port: number;
  readonly tlsCertificateFile: string;
  readonly tlsPrivateKeyFile: string;
  readonly tlsCertificateAuthorityFile: string;
  readonly workloadTokenSha256s: readonly string[];
  readonly wechatAppId: string;
  readonly wechatAppSecretFile: string;
  readonly identityProviderUrl: string;
  readonly identityProviderTokenFile: string;
  readonly redisUrl: string;
  readonly s3Bucket: string;
  readonly s3Region: string;
  readonly s3KmsKeyId: string;
  readonly objectKeyPrefix: string;
  readonly mediaSafetyScannerUrl?: string;
  readonly mediaSafetyScannerTokenFile?: string;
  readonly mediaSafetyReceiptPublicKeyFile?: string;
  readonly mediaSafetyExpectedProvider?: string;
  readonly mediaSafetyExpectedPolicyId?: string;
  readonly mediaSafetyPolicySha256?: string;
  readonly mediaSafetyExpectedModelVersion?: string;
  readonly mediaSafetyExpectedKeyId?: string;
  readonly mediaSafetyExpectedEnvironment?: "test" | "development" | "staging" | "production";
  readonly mediaLifecycleCatalogFile?: string;
  readonly mediaLifecycleTrustPublicKeyFile?: string;
  readonly mediaLifecycleExpectedKeyId?: string;
  readonly mediaLifecycleExpectedIssuer?: string;
  readonly mediaLifecycleExpectedEnvironment?: "test" | "development" | "staging" | "production";
  readonly mediaLifecycleTargetSecretRoot?: string;
  readonly mediaDownloadPrivateKeyFile?: string;
  readonly mediaDownloadPublicKeyFile?: string;
  readonly mediaDownloadBaseUrl?: string;
  readonly mediaDownloadIssuer?: string;
  readonly mediaDownloadMaximumTtlSeconds: number;
  readonly mediaLifecycleMaintenanceIntervalMs: number;
  readonly mediaLifecycleMaintenanceTenantIds: readonly string[];
  readonly dependencyTimeoutMs: number;
}

export function loadBrokerConfiguration(environment: NodeJS.ProcessEnv): BrokerConfiguration {
  const appEnvironment = oneOf(
    environment.APP_ENV?.trim().toLowerCase() || "development",
    "APP_ENV",
    ["test", "development", "staging", "production"] as const,
  );
  const tlsCertificateFile = absolute(required(environment.LTM_BROKER_TLS_CERT_FILE, "LTM_BROKER_TLS_CERT_FILE"), "LTM_BROKER_TLS_CERT_FILE");
  const tlsPrivateKeyFile = absolute(required(environment.LTM_BROKER_TLS_KEY_FILE, "LTM_BROKER_TLS_KEY_FILE"), "LTM_BROKER_TLS_KEY_FILE");
  const tlsCertificateAuthorityFile = absolute(required(
    environment.LTM_BROKER_TLS_CA_FILE,
    "LTM_BROKER_TLS_CA_FILE",
  ), "LTM_BROKER_TLS_CA_FILE");
  const workloadTokenSha256s = commaList(required(
    environment.LTM_BROKER_WORKLOAD_TOKEN_SHA256S,
    "LTM_BROKER_WORKLOAD_TOKEN_SHA256S",
  ), "LTM_BROKER_WORKLOAD_TOKEN_SHA256S", 8);
  if (workloadTokenSha256s.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw configuration("LTM_BROKER_WORKLOAD_TOKEN_SHA256S must contain lowercase SHA-256 digests");
  }
  const redisUrl = required(environment.LTM_BROKER_REDIS_URL, "LTM_BROKER_REDIS_URL", 2_048);
  let parsedRedis: URL;
  try { parsedRedis = new URL(redisUrl); } catch { throw configuration("LTM_BROKER_REDIS_URL is invalid"); }
  if (appEnvironment === "production" && parsedRedis.protocol !== "rediss:") throw configuration("production Redis must use TLS");
  const identityProviderUrl = required(environment.LTM_ENTERPRISE_IDP_URL, "LTM_ENTERPRISE_IDP_URL", 2_048);
  try {
    if (new URL(identityProviderUrl).protocol !== "https:") throw new Error("not HTTPS");
  } catch { throw configuration("LTM_ENTERPRISE_IDP_URL must be HTTPS"); }
  const mediaSafetyScannerUrl = optional(environment.LTM_MEDIA_SAFETY_SCANNER_URL, 2_048);
  const mediaSafetyScannerTokenFileValue = optional(environment.LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE, 4_096);
  if ((mediaSafetyScannerUrl === undefined) !== (mediaSafetyScannerTokenFileValue === undefined)) {
    throw configuration("media safety scanner URL and token file must be configured together");
  }
  if (mediaSafetyScannerUrl !== undefined) {
    try {
      const scanner = new URL(mediaSafetyScannerUrl);
      if (scanner.protocol !== "https:" || scanner.username || scanner.password || scanner.search || scanner.hash ||
          !["", "/"].includes(scanner.pathname)) throw new Error("invalid scanner origin");
    } catch { throw configuration("LTM_MEDIA_SAFETY_SCANNER_URL must be a credential-free HTTPS origin"); }
  }
  const mediaSafetyScannerTokenFile = mediaSafetyScannerTokenFileValue === undefined
    ? undefined
    : absolute(mediaSafetyScannerTokenFileValue, "LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE");
  const mediaSafetyReceiptPublicKeyFileValue = optional(environment.LTM_MEDIA_SAFETY_RECEIPT_PUBLIC_KEY_FILE, 4_096);
  const mediaSafetyExpectedProvider = optional(environment.LTM_MEDIA_SAFETY_EXPECTED_PROVIDER, 256);
  const mediaSafetyExpectedPolicyId = optional(environment.LTM_MEDIA_SAFETY_EXPECTED_POLICY_ID, 256);
  const mediaSafetyPolicySha256 = optional(environment.LTM_MEDIA_SAFETY_POLICY_SHA256, 64);
  const mediaSafetyExpectedModelVersion = optional(environment.LTM_MEDIA_SAFETY_EXPECTED_MODEL_VERSION, 256);
  const mediaSafetyExpectedKeyId = optional(environment.LTM_MEDIA_SAFETY_EXPECTED_KEY_ID, 256);
  const mediaSafetyExpectedEnvironmentValue = optional(environment.LTM_MEDIA_SAFETY_EXPECTED_ENVIRONMENT, 32);
  const scannerAuthorityValues = [mediaSafetyReceiptPublicKeyFileValue, mediaSafetyExpectedProvider, mediaSafetyExpectedPolicyId,
    mediaSafetyPolicySha256, mediaSafetyExpectedModelVersion, mediaSafetyExpectedKeyId, mediaSafetyExpectedEnvironmentValue];
  const scannerAuthorityConfigured = scannerAuthorityValues.every((value) => value !== undefined);
  if (!scannerAuthorityConfigured && scannerAuthorityValues.some((value) => value !== undefined)) {
    throw configuration("media safety signed receipt authority fields must be configured together");
  }
  if (mediaSafetyPolicySha256 !== undefined && !/^[a-f0-9]{64}$/.test(mediaSafetyPolicySha256)) {
    throw configuration("LTM_MEDIA_SAFETY_POLICY_SHA256 must be a lowercase SHA-256 digest");
  }
  const mediaSafetyExpectedEnvironment = mediaSafetyExpectedEnvironmentValue === undefined
    ? undefined
    : oneOf(mediaSafetyExpectedEnvironmentValue, "LTM_MEDIA_SAFETY_EXPECTED_ENVIRONMENT", ["test", "development", "staging", "production"] as const);
  if (appEnvironment === "production" && (mediaSafetyScannerUrl === undefined || mediaSafetyScannerTokenFile === undefined ||
      !scannerAuthorityConfigured || mediaSafetyExpectedEnvironment !== "production")) {
    throw configuration("production requires a signed production media safety scanner receipt authority");
  }
  const mediaLifecycleCatalogFileValue = optional(environment.LTM_MEDIA_LIFECYCLE_CATALOG_FILE, 4_096);
  const mediaLifecycleTrustPublicKeyFileValue = optional(environment.LTM_MEDIA_LIFECYCLE_TRUST_PUBLIC_KEY_FILE, 4_096);
  const mediaLifecycleExpectedKeyId = optional(environment.LTM_MEDIA_LIFECYCLE_EXPECTED_KEY_ID, 256);
  const mediaLifecycleExpectedIssuer = optional(environment.LTM_MEDIA_LIFECYCLE_EXPECTED_ISSUER, 256);
  const mediaLifecycleExpectedEnvironmentValue = optional(environment.LTM_MEDIA_LIFECYCLE_EXPECTED_ENVIRONMENT, 32);
  const mediaLifecycleTargetSecretRootValue = optional(environment.LTM_MEDIA_LIFECYCLE_TARGET_SECRET_ROOT, 4_096);
  const lifecycleConfigured = [mediaLifecycleCatalogFileValue, mediaLifecycleTrustPublicKeyFileValue, mediaLifecycleExpectedKeyId,
    mediaLifecycleExpectedIssuer, mediaLifecycleExpectedEnvironmentValue]
    .every((value) => value !== undefined);
  if (!lifecycleConfigured && [mediaLifecycleCatalogFileValue, mediaLifecycleTrustPublicKeyFileValue, mediaLifecycleExpectedKeyId,
      mediaLifecycleExpectedIssuer, mediaLifecycleExpectedEnvironmentValue]
      .some((value) => value !== undefined)) throw configuration("media lifecycle catalog, trust key, and expected key ID must be configured together");
  if (!lifecycleConfigured && mediaLifecycleTargetSecretRootValue !== undefined) {
    throw configuration("media lifecycle target secret root requires the signed lifecycle catalog configuration");
  }
  if (appEnvironment === "production" && !lifecycleConfigured) throw configuration("production requires a signed media lifecycle catalog");
  const mediaLifecycleExpectedEnvironment = mediaLifecycleExpectedEnvironmentValue === undefined
    ? undefined
    : oneOf(mediaLifecycleExpectedEnvironmentValue, "LTM_MEDIA_LIFECYCLE_EXPECTED_ENVIRONMENT", ["test", "development", "staging", "production"] as const);
  if (appEnvironment === "production" && mediaLifecycleExpectedEnvironment !== "production") {
    throw configuration("production requires a production media lifecycle catalog environment");
  }
  if (appEnvironment === "production" && mediaLifecycleTargetSecretRootValue === undefined) {
    throw configuration("production requires LTM_MEDIA_LIFECYCLE_TARGET_SECRET_ROOT");
  }
  const mediaDownloadPrivateKeyFileValue = optional(environment.LTM_MEDIA_DOWNLOAD_PRIVATE_KEY_FILE, 4_096);
  const mediaDownloadPublicKeyFileValue = optional(environment.LTM_MEDIA_DOWNLOAD_PUBLIC_KEY_FILE, 4_096);
  const mediaDownloadBaseUrl = optional(environment.LTM_MEDIA_DOWNLOAD_BASE_URL, 2_048);
  const mediaDownloadIssuer = optional(environment.LTM_MEDIA_DOWNLOAD_ISSUER, 256);
  const downloadConfigured = [mediaDownloadPrivateKeyFileValue, mediaDownloadPublicKeyFileValue, mediaDownloadBaseUrl, mediaDownloadIssuer]
    .every((value) => value !== undefined);
  if (!downloadConfigured && [mediaDownloadPrivateKeyFileValue, mediaDownloadPublicKeyFileValue, mediaDownloadBaseUrl, mediaDownloadIssuer]
      .some((value) => value !== undefined)) throw configuration("media download key pair, base URL, and issuer must be configured together");
  if (appEnvironment === "production" && !downloadConfigured) throw configuration("production requires media download authorization signing configuration");
  if (mediaDownloadBaseUrl !== undefined) {
    try {
      const url = new URL(mediaDownloadBaseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("invalid");
    } catch { throw configuration("LTM_MEDIA_DOWNLOAD_BASE_URL must be a credential-free HTTPS origin"); }
  }
  const mediaLifecycleMaintenanceTenantIds = environment.LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS === undefined
    ? []
    : commaList(environment.LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS, "LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS", 1_000);
  if (mediaLifecycleMaintenanceTenantIds.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value))) {
    throw configuration("LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS contains an invalid tenant ID");
  }
  if (appEnvironment === "production" && mediaLifecycleMaintenanceTenantIds.length < 1) {
    throw configuration("production requires LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS");
  }
  return {
    appEnvironment,
    host: host(environment.HOST ?? "0.0.0.0"),
    port: integer(environment.PORT, 8_082, 1, 65_535, "PORT"),
    tlsCertificateFile,
    tlsPrivateKeyFile,
    tlsCertificateAuthorityFile,
    workloadTokenSha256s,
    wechatAppId: required(environment.LTM_WECHAT_APP_ID, "LTM_WECHAT_APP_ID", 64),
    wechatAppSecretFile: absolute(required(environment.LTM_WECHAT_APP_SECRET_FILE, "LTM_WECHAT_APP_SECRET_FILE"), "LTM_WECHAT_APP_SECRET_FILE"),
    identityProviderUrl,
    identityProviderTokenFile: absolute(required(environment.LTM_ENTERPRISE_IDP_TOKEN_FILE, "LTM_ENTERPRISE_IDP_TOKEN_FILE"), "LTM_ENTERPRISE_IDP_TOKEN_FILE"),
    redisUrl,
    s3Bucket: required(environment.LTM_MEDIA_S3_BUCKET, "LTM_MEDIA_S3_BUCKET", 63),
    s3Region: required(environment.LTM_MEDIA_S3_REGION ?? environment.AWS_REGION, "LTM_MEDIA_S3_REGION", 32),
    s3KmsKeyId: required(environment.LTM_MEDIA_S3_KMS_KEY_ID, "LTM_MEDIA_S3_KMS_KEY_ID", 2_048),
    objectKeyPrefix: required(environment.LTM_MEDIA_S3_PREFIX ?? "media/v1", "LTM_MEDIA_S3_PREFIX", 128),
    ...(mediaSafetyScannerUrl === undefined || mediaSafetyScannerTokenFile === undefined
      ? {}
      : { mediaSafetyScannerUrl, mediaSafetyScannerTokenFile }),
    ...(mediaSafetyReceiptPublicKeyFileValue === undefined || mediaSafetyExpectedProvider === undefined ||
        mediaSafetyExpectedPolicyId === undefined || mediaSafetyPolicySha256 === undefined || mediaSafetyExpectedModelVersion === undefined ||
        mediaSafetyExpectedKeyId === undefined || mediaSafetyExpectedEnvironment === undefined
      ? {}
      : {
          mediaSafetyReceiptPublicKeyFile: absolute(mediaSafetyReceiptPublicKeyFileValue, "LTM_MEDIA_SAFETY_RECEIPT_PUBLIC_KEY_FILE"),
          mediaSafetyExpectedProvider,
          mediaSafetyExpectedPolicyId,
          mediaSafetyPolicySha256,
          mediaSafetyExpectedModelVersion,
          mediaSafetyExpectedKeyId,
          mediaSafetyExpectedEnvironment,
        }),
    ...(mediaLifecycleCatalogFileValue === undefined || mediaLifecycleTrustPublicKeyFileValue === undefined || mediaLifecycleExpectedKeyId === undefined ||
        mediaLifecycleExpectedIssuer === undefined || mediaLifecycleExpectedEnvironment === undefined
      ? {}
      : {
          mediaLifecycleCatalogFile: absolute(mediaLifecycleCatalogFileValue, "LTM_MEDIA_LIFECYCLE_CATALOG_FILE"),
          mediaLifecycleTrustPublicKeyFile: absolute(mediaLifecycleTrustPublicKeyFileValue, "LTM_MEDIA_LIFECYCLE_TRUST_PUBLIC_KEY_FILE"),
          mediaLifecycleExpectedKeyId,
          mediaLifecycleExpectedIssuer,
          mediaLifecycleExpectedEnvironment,
          ...(mediaLifecycleTargetSecretRootValue === undefined
            ? {}
            : { mediaLifecycleTargetSecretRoot: absolute(mediaLifecycleTargetSecretRootValue, "LTM_MEDIA_LIFECYCLE_TARGET_SECRET_ROOT") }),
        }),
    ...(mediaDownloadPrivateKeyFileValue === undefined || mediaDownloadPublicKeyFileValue === undefined ||
        mediaDownloadBaseUrl === undefined || mediaDownloadIssuer === undefined
      ? {}
      : {
          mediaDownloadPrivateKeyFile: absolute(mediaDownloadPrivateKeyFileValue, "LTM_MEDIA_DOWNLOAD_PRIVATE_KEY_FILE"),
          mediaDownloadPublicKeyFile: absolute(mediaDownloadPublicKeyFileValue, "LTM_MEDIA_DOWNLOAD_PUBLIC_KEY_FILE"),
          mediaDownloadBaseUrl,
          mediaDownloadIssuer,
        }),
    mediaDownloadMaximumTtlSeconds: integer(environment.LTM_MEDIA_DOWNLOAD_MAXIMUM_TTL_SECONDS, 300, 30, 900, "LTM_MEDIA_DOWNLOAD_MAXIMUM_TTL_SECONDS"),
    mediaLifecycleMaintenanceIntervalMs: integer(environment.LTM_MEDIA_LIFECYCLE_MAINTENANCE_INTERVAL_MS, 60_000, 10_000, 86_400_000, "LTM_MEDIA_LIFECYCLE_MAINTENANCE_INTERVAL_MS"),
    mediaLifecycleMaintenanceTenantIds,
    dependencyTimeoutMs: integer(environment.LTM_BROKER_DEPENDENCY_TIMEOUT_MS, 8_000, 500, 30_000, "LTM_BROKER_DEPENDENCY_TIMEOUT_MS"),
  };
}

function optional(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw configuration("optional configuration is invalid");
  return normalized;
}

function required(value: string | undefined, label: string, maximum = 8_192): string {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw configuration(`${label} is required and bounded`);
  }
  return normalized;
}

function absolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw configuration(`${label} must be an absolute path`);
  return value;
}

function host(value: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 255 || /[\u0000-\u0020\u007f/?#]/.test(normalized)) throw configuration("HOST is invalid");
  return normalized;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw configuration(`${label} is invalid`);
  return parsed;
}

function commaList(value: string, label: string, maximum: number): readonly string[] {
  const result = value.split(",").map((entry) => entry.trim());
  if (result.length < 1 || result.length > maximum || result.some((entry) => entry === "") || new Set(result).size !== result.length) {
    throw configuration(`${label} is invalid`);
  }
  return result;
}

function oneOf<T extends string>(value: string, label: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw configuration(`${label} is invalid`);
  return value as T;
}
