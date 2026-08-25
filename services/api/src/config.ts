import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DomainError, verifyConsentPolicyCatalog } from "@ltm/core";
import type {
  EvidenceEnvironment,
  PostgresRuntimeOptions,
  Role,
  RuntimeOptions,
  TrustedEvidenceKey,
  TrustedConsentPolicyKey,
} from "@ltm/core";
import { StaticTokenAuthenticator, type RequestAuthenticator } from "./auth.js";
import { OidcAuthenticator, type OidcAlgorithm } from "./oidc-auth.js";
import {
  HttpResumableUploadBroker,
  HttpWechatIdentityBroker,
  type ClientIntegrationPorts,
} from "./client-integrations.js";
import { configuredBrowserOidc, type BrowserOidcPublicConfiguration } from "./browser-oidc.js";

export type AppEnvironment = "local" | "development" | "test" | "staging" | "production";
export type DeploymentProfile = "single-node" | "distributed";

export interface ApiConfiguration {
  readonly appEnvironment: AppEnvironment;
  readonly authMode: "oidc" | "configured-tokens" | "local-synthetic-only";
  readonly deploymentProfile: DeploymentProfile;
  readonly authenticator: RequestAuthenticator;
  readonly runtimeOptions: RuntimeOptions;
  readonly postgresRuntimeOptions: PostgresRuntimeOptions | undefined;
  readonly port: number;
  readonly host: string;
  readonly bodyLimitBytes: number;
  readonly staticDirectory: string | null | undefined;
  readonly allowSandboxStepUpHeader: boolean;
  readonly metricsTokenSha256: string | undefined;
  readonly clientIntegrations: ClientIntegrationPorts;
  readonly browserOidcConfiguration: BrowserOidcPublicConfiguration | undefined;
}

const EVIDENCE_ENVIRONMENT: Readonly<Record<AppEnvironment, EvidenceEnvironment>> = {
  local: "sandbox",
  development: "sandbox",
  test: "test",
  staging: "staging",
  production: "production",
};

const FORBIDDEN_VERIFIER_SECRETS = [
  "LTM_EVIDENCE_PRIVATE_KEY",
  "LTM_EVIDENCE_PRIVATE_KEY_PEM",
  "LTM_EVIDENCE_PRIVATE_KEY_BASE64",
  "LTM_SIGNING_PRIVATE_KEY",
] as const;

export function loadApiConfiguration(
  environment: NodeJS.ProcessEnv,
  productRoot: string,
): ApiConfiguration {
  for (const name of FORBIDDEN_VERIFIER_SECRETS) {
    if ((environment[name]?.trim().length ?? 0) > 0) {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        `${name} is forbidden in the API verifier; configure only trusted public keys`,
      );
    }
  }
  const appEnvironment = enumValue(
    environment.APP_ENV?.trim().toLowerCase() || "local",
    "APP_ENV",
    ["local", "development", "test", "staging", "production"] as const,
  );
  const authMode = enumValue(
    environment.LTM_AUTH_MODE?.trim() || "configured-tokens",
    "LTM_AUTH_MODE",
    ["oidc", "configured-tokens", "local-synthetic-only"] as const,
  );
  if (authMode === "local-synthetic-only" && !["local", "development", "test"].includes(appEnvironment)) {
    throw new DomainError("CONFIGURATION_INVALID", "Synthetic authentication is limited to local, development, or test");
  }
  const deploymentProfile = enumValue(
    environment.LTM_DEPLOYMENT_PROFILE?.trim() || (appEnvironment === "production" ? "distributed" : "single-node"),
    "LTM_DEPLOYMENT_PROFILE",
    ["single-node", "distributed"] as const,
  );
  if (appEnvironment === "production") {
    if (deploymentProfile === "single-node" && environment.LTM_ALLOW_SINGLE_NODE_SQLITE !== "true") {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "Single-node production SQLite requires explicit LTM_ALLOW_SINGLE_NODE_SQLITE=true acceptance",
      );
    }
    if (deploymentProfile === "distributed" && authMode !== "oidc") {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "Distributed production requires OIDC/JWKS authentication; static or synthetic tokens are not accepted",
      );
    }
    if (deploymentProfile === "single-node" && authMode === "configured-tokens" &&
        environment.LTM_ALLOW_STATIC_TOKEN_AUTH !== "true") {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "Static token authentication is not enterprise OIDC; explicit LTM_ALLOW_STATIC_TOKEN_AUTH=true acceptance is required",
      );
    }
  }
  if (appEnvironment === "production" && authMode === "configured-tokens") {
    assertDigestOnlyProductionTokens(environment.LTM_API_TOKENS_JSON);
  }
  const authenticator = configuredAuthenticator(authMode, appEnvironment, environment);

  const databasePath = resolveProductPath(
    environment.LTM_DATABASE_PATH?.trim() || ".data/ltm-local.sqlite",
    productRoot,
  );
  if (appEnvironment === "production" && databasePath === ":memory:") {
    throw new DomainError("CONFIGURATION_INVALID", "Production cannot use an in-memory database");
  }
  if (deploymentProfile === "distributed" && environment.LTM_DATABASE_PATH?.trim()) {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "LTM_DATABASE_PATH is incompatible with the distributed PostgreSQL profile",
    );
  }
  const trustedEvidenceKeys = parseTrustedEvidenceKeys(environment.LTM_EVIDENCE_TRUST_KEYS_JSON);
  if (appEnvironment === "production" && trustedEvidenceKeys.length === 0) {
    throw new DomainError("CONFIGURATION_INVALID", "Production requires LTM_EVIDENCE_TRUST_KEYS_JSON");
  }
  const metricsTokenSha256 = optionalDigest(environment.LTM_METRICS_TOKEN_SHA256, "LTM_METRICS_TOKEN_SHA256");
  if (appEnvironment === "production" && metricsTokenSha256 === undefined) {
    throw new DomainError("CONFIGURATION_INVALID", "Production requires LTM_METRICS_TOKEN_SHA256");
  }
  const staticValue = environment.LTM_STATIC_DIR?.trim();
  const staticDirectory = staticValue === undefined || staticValue.length === 0
    ? undefined
    : staticValue === "disabled"
      ? null
      : resolveProductPath(staticValue, productRoot);
  const sandboxStepUpRequested = environment.LTM_SANDBOX_STEP_UP_HEADER === "true";
  if (environment.LTM_SANDBOX_STEP_UP_HEADER !== undefined &&
      environment.LTM_SANDBOX_STEP_UP_HEADER !== "true" &&
      environment.LTM_SANDBOX_STEP_UP_HEADER !== "false") {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_SANDBOX_STEP_UP_HEADER must be true or false");
  }
  const clientIntegrations = configuredClientIntegrations(environment, appEnvironment);
  const consentPolicyOptions = configuredConsentPolicy(environment, appEnvironment, productRoot);
  const browserOidcConfiguration = configuredBrowserOidc(
    environment,
    appEnvironment,
    authMode,
    staticDirectory !== null,
  );
  return {
    appEnvironment,
    authMode,
    deploymentProfile,
    authenticator,
    runtimeOptions: {
      databasePath,
      trustedEvidenceKeys,
      evidencePolicy: appEnvironment === "production"
        ? "production"
        : trustedEvidenceKeys.length > 0
          ? "development"
          : "disabled",
      evidenceEnvironment: EVIDENCE_ENVIRONMENT[appEnvironment],
      busyTimeoutMs: integerValue(environment.LTM_SQLITE_BUSY_TIMEOUT_MS, 5_000, 100, 60_000, "LTM_SQLITE_BUSY_TIMEOUT_MS"),
      evidenceClockSkewMs: integerValue(environment.LTM_EVIDENCE_CLOCK_SKEW_MS, 300_000, 0, 900_000, "LTM_EVIDENCE_CLOCK_SKEW_MS"),
      maxEvidenceLifetimeMs: integerValue(
        environment.LTM_EVIDENCE_MAX_LIFETIME_MS,
        30 * 24 * 60 * 60 * 1_000,
        60_000,
        366 * 24 * 60 * 60 * 1_000,
        "LTM_EVIDENCE_MAX_LIFETIME_MS",
      ),
      ...consentPolicyOptions,
    },
    postgresRuntimeOptions: deploymentProfile === "distributed"
      ? postgresRuntimeOptions(environment, appEnvironment, trustedEvidenceKeys, consentPolicyOptions)
      : undefined,
    port: integerValue(environment.PORT, 8_080, 1, 65_535, "PORT"),
    host: visibleValue(environment.HOST?.trim() || "127.0.0.1", "HOST", 255),
    bodyLimitBytes: integerValue(environment.LTM_BODY_LIMIT_BYTES, 256 * 1_024, 1_024, 10 * 1_024 * 1_024, "LTM_BODY_LIMIT_BYTES"),
    staticDirectory,
    allowSandboxStepUpHeader: authMode === "local-synthetic-only" && sandboxStepUpRequested,
    metricsTokenSha256,
    clientIntegrations,
    browserOidcConfiguration,
  };
}

function configuredClientIntegrations(
  environment: NodeJS.ProcessEnv,
  appEnvironment: AppEnvironment,
): ClientIntegrationPorts {
  const wechatUrl = environment.LTM_WECHAT_IDENTITY_BROKER_URL?.trim();
  const wechatTokenFile = environment.LTM_WECHAT_IDENTITY_TOKEN_FILE?.trim();
  const uploadUrl = environment.LTM_UPLOAD_BROKER_URL?.trim();
  const uploadTokenFile = environment.LTM_UPLOAD_BROKER_TOKEN_FILE?.trim();
  if ((wechatUrl === undefined) !== (wechatTokenFile === undefined)) {
    throw new DomainError("CONFIGURATION_INVALID", "WeChat identity broker URL and workload token file must be configured together");
  }
  if ((uploadUrl === undefined) !== (uploadTokenFile === undefined)) {
    throw new DomainError("CONFIGURATION_INVALID", "Upload broker URL and workload token file must be configured together");
  }
  if (appEnvironment === "production" && (wechatUrl === undefined || uploadUrl === undefined)) {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "Full-commercial production requires the WeChat identity and resumable upload brokers",
    );
  }
  const allowInsecureLoopback = appEnvironment !== "production";
  return {
    ...(wechatUrl === undefined || wechatTokenFile === undefined ? {} : {
      wechatIdentity: new HttpWechatIdentityBroker({
        baseUrl: wechatUrl,
        workloadTokenFile: wechatTokenFile,
        allowInsecureLoopback,
      }),
    }),
    ...(uploadUrl === undefined || uploadTokenFile === undefined ? {} : {
      resumableUploads: new HttpResumableUploadBroker({
        baseUrl: uploadUrl,
        workloadTokenFile: uploadTokenFile,
        allowInsecureLoopback,
      }),
    }),
  };
}

function postgresRuntimeOptions(
  environment: NodeJS.ProcessEnv,
  appEnvironment: AppEnvironment,
  trustedEvidenceKeys: readonly TrustedEvidenceKey[],
  consentPolicyOptions: Pick<RuntimeOptions,
    "consentPolicyCatalog" | "trustedConsentPolicyKeys" | "consentPolicyJurisdiction" |
    "consentPolicyLocale" | "allowLegacyConsentPolicy">,
): PostgresRuntimeOptions {
  const connectionString = requiredEnvironment(environment.DATABASE_URL, "DATABASE_URL", 4_096);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", "DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DomainError("CONFIGURATION_INVALID", "DATABASE_URL must use postgres:// or postgresql://");
  }
  if (url.username.length === 0 || url.hostname.length === 0 || url.pathname.length <= 1 || url.hash.length > 0) {
    throw new DomainError("CONFIGURATION_INVALID", "DATABASE_URL must identify a PostgreSQL role, host, and database");
  }
  const sslMode = url.searchParams.get("sslmode");
  if (appEnvironment === "production" && sslMode !== "verify-full") {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "Distributed production DATABASE_URL must set sslmode=verify-full",
    );
  }
  return {
    connectionString,
    applicationName: visibleValue(environment.LTM_POSTGRES_APPLICATION_NAME?.trim() || "ltm-api", "LTM_POSTGRES_APPLICATION_NAME", 63),
    poolMax: integerValue(environment.LTM_POSTGRES_POOL_MAX, 10, 1, 100, "LTM_POSTGRES_POOL_MAX"),
    connectionTimeoutMs: integerValue(
      environment.LTM_POSTGRES_CONNECTION_TIMEOUT_MS,
      5_000,
      100,
      60_000,
      "LTM_POSTGRES_CONNECTION_TIMEOUT_MS",
    ),
    idleTimeoutMs: integerValue(
      environment.LTM_POSTGRES_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      600_000,
      "LTM_POSTGRES_IDLE_TIMEOUT_MS",
    ),
    statementTimeoutMs: integerValue(
      environment.LTM_POSTGRES_STATEMENT_TIMEOUT_MS,
      15_000,
      1_000,
      120_000,
      "LTM_POSTGRES_STATEMENT_TIMEOUT_MS",
    ),
    trustedEvidenceKeys,
    evidencePolicy: appEnvironment === "production"
      ? "production"
      : trustedEvidenceKeys.length > 0
        ? "development"
        : "disabled",
    evidenceEnvironment: EVIDENCE_ENVIRONMENT[appEnvironment],
    evidenceClockSkewMs: integerValue(
      environment.LTM_EVIDENCE_CLOCK_SKEW_MS,
      300_000,
      0,
      900_000,
      "LTM_EVIDENCE_CLOCK_SKEW_MS",
    ),
    maxEvidenceLifetimeMs: integerValue(
      environment.LTM_EVIDENCE_MAX_LIFETIME_MS,
      30 * 24 * 60 * 60 * 1_000,
      60_000,
      366 * 24 * 60 * 60 * 1_000,
      "LTM_EVIDENCE_MAX_LIFETIME_MS",
    ),
    ...consentPolicyOptions,
  };
}

function configuredConsentPolicy(
  environment: NodeJS.ProcessEnv,
  appEnvironment: AppEnvironment,
  productRoot: string,
): Pick<RuntimeOptions,
  "consentPolicyCatalog" | "trustedConsentPolicyKeys" | "consentPolicyJurisdiction" |
  "consentPolicyLocale" | "allowLegacyConsentPolicy"> {
  const catalogFile = environment.LTM_CONSENT_POLICY_CATALOG_FILE?.trim();
  const trustJson = environment.LTM_CONSENT_POLICY_TRUST_KEYS_JSON?.trim();
  const jurisdiction = environment.LTM_CONSENT_POLICY_JURISDICTION?.trim();
  const locale = environment.LTM_CONSENT_POLICY_LOCALE?.trim();
  const legacyValue = environment.LTM_ALLOW_LEGACY_CONSENT_POLICY;
  if (legacyValue !== undefined && legacyValue !== "true" && legacyValue !== "false") {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_ALLOW_LEGACY_CONSENT_POLICY must be true or false");
  }
  const allowLegacyConsentPolicy = legacyValue === "true";
  if (allowLegacyConsentPolicy && appEnvironment === "production") {
    throw new DomainError("CONFIGURATION_INVALID", "Legacy consent policy mode is forbidden in production");
  }
  const supplied = [catalogFile, trustJson, jurisdiction, locale].filter((value) => value !== undefined).length;
  if (supplied !== 0 && supplied !== 4) {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "Consent policy catalog file, trust keys JSON, jurisdiction, and locale must be configured together",
    );
  }
  if (supplied === 0) {
    if (appEnvironment === "production") {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "Production requires LTM_CONSENT_POLICY_CATALOG_FILE, trust keys, jurisdiction, and locale",
      );
    }
    return allowLegacyConsentPolicy ? { allowLegacyConsentPolicy: true } : {};
  }
  if (allowLegacyConsentPolicy) {
    throw new DomainError("CONFIGURATION_INVALID", "Legacy consent policy mode cannot accompany a signed catalog");
  }
  const path = resolveProductPath(catalogFile!, productRoot);
  const catalogValue = readBoundedJsonFile(path, "LTM_CONSENT_POLICY_CATALOG_FILE", 2 * 1_024 * 1_024);
  const trustedConsentPolicyKeys = parseTrustedConsentPolicyKeys(trustJson);
  const verified = verifyConsentPolicyCatalog(
    catalogValue,
    trustedConsentPolicyKeys,
    EVIDENCE_ENVIRONMENT[appEnvironment],
    new Date().toISOString(),
  );
  return {
    consentPolicyCatalog: verified.document,
    trustedConsentPolicyKeys,
    consentPolicyJurisdiction: visibleValue(jurisdiction!, "LTM_CONSENT_POLICY_JURISDICTION", 32),
    consentPolicyLocale: visibleValue(locale!, "LTM_CONSENT_POLICY_LOCALE", 16),
  };
}

function configuredAuthenticator(
  authMode: ApiConfiguration["authMode"],
  appEnvironment: AppEnvironment,
  environment: NodeJS.ProcessEnv,
): RequestAuthenticator {
  if (authMode === "local-synthetic-only") return StaticTokenAuthenticator.localSynthetic(appEnvironment);
  if (authMode === "configured-tokens") return StaticTokenAuthenticator.fromEnvironment(environment.LTM_API_TOKENS_JSON);
  const issuer = requiredEnvironment(environment.LTM_OIDC_ISSUER, "LTM_OIDC_ISSUER", 1_024);
  const audience = requiredEnvironment(environment.LTM_OIDC_AUDIENCE, "LTM_OIDC_AUDIENCE", 512);
  const jwksValue = requiredEnvironment(environment.LTM_OIDC_JWKS_URL, "LTM_OIDC_JWKS_URL", 1_024);
  let jwksUrl: URL;
  try {
    jwksUrl = new URL(jwksValue);
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_OIDC_JWKS_URL must be a valid URL");
  }
  const algorithms = commaEnumList(
    environment.LTM_OIDC_ALGORITHMS ?? "RS256,ES256",
    "LTM_OIDC_ALGORITHMS",
    ["RS256", "PS256", "ES256", "EdDSA"] as const,
  ) as readonly OidcAlgorithm[];
  const roleMap = parseOidcRoleMap(environment.LTM_OIDC_ROLE_MAP_JSON);
  return new OidcAuthenticator({
    issuer,
    audience,
    jwksUrl,
    algorithms,
    tokenType: environment.LTM_OIDC_TOKEN_TYP?.trim() || "at+jwt",
    maximumTokenAgeSeconds: integerValue(environment.LTM_OIDC_MAX_TOKEN_AGE_SECONDS, 900, 60, 3_600, "LTM_OIDC_MAX_TOKEN_AGE_SECONDS"),
    clockToleranceSeconds: integerValue(environment.LTM_OIDC_CLOCK_TOLERANCE_SECONDS, 5, 0, 60, "LTM_OIDC_CLOCK_TOLERANCE_SECONDS"),
    tenantClaim: environment.LTM_OIDC_TENANT_CLAIM?.trim() || "tenant_id",
    rolesClaim: environment.LTM_OIDC_ROLES_CLAIM?.trim() || "roles",
    permissionsClaim: environment.LTM_OIDC_PERMISSIONS_CLAIM?.trim() || "permissions",
    purposesClaim: environment.LTM_OIDC_PURPOSES_CLAIM?.trim() || "purposes",
    ...(roleMap === undefined ? {} : { roleMap }),
    stepUpAcrValues: commaList(environment.LTM_OIDC_STEP_UP_ACR_VALUES ?? "urn:ltm:acr:mfa", "LTM_OIDC_STEP_UP_ACR_VALUES"),
    ...(environment.LTM_OIDC_GUARDIAN_VERIFIED_CLAIM?.trim()
      ? { guardianVerifiedClaim: environment.LTM_OIDC_GUARDIAN_VERIFIED_CLAIM.trim() }
      : {}),
  });
}

function parseOidcRoleMap(serialized: string | undefined): Readonly<Record<string, Role>> | undefined {
  if (serialized === undefined || serialized.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_OIDC_ROLE_MAP_JSON must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 100) {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_OIDC_ROLE_MAP_JSON must be a bounded object");
  }
  return parsed as Record<string, Role>;
}

function requiredEnvironment(value: string | undefined, label: string, maximum: number): string {
  if (value === undefined) throw new DomainError("CONFIGURATION_INVALID", `${label} is required`);
  return visibleValue(value.trim(), label, maximum);
}

function commaList(value: string, label: string): readonly string[] {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0 || items.length > 20 || new Set(items).size !== items.length) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be a non-empty unique comma-separated list`);
  }
  return items.map((item) => visibleValue(item, label, 256));
}

function commaEnumList<T extends string>(value: string, label: string, allowed: readonly T[]): readonly T[] {
  const items = commaList(value, label);
  if (items.some((item) => !allowed.includes(item as T))) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} contains an unsupported value`);
  }
  return items as T[];
}

function parseTrustedEvidenceKeys(serialized: string | undefined): readonly TrustedEvidenceKey[] {
  if (serialized === undefined || serialized.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_EVIDENCE_TRUST_KEYS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_EVIDENCE_TRUST_KEYS_JSON must be an array of at most 100 keys");
  }
  return parsed.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new DomainError("CONFIGURATION_INVALID", "Each trusted evidence key must be an object");
    }
    const record = value as Record<string, unknown>;
    const allowedFields = new Set([
      "issuer", "provider", "keyId", "algorithm", "publicKeyPem", "allowedScopes",
      "allowedEnvironments", "notBefore", "notAfter",
    ]);
    if (Object.keys(record).some((field) => !allowedFields.has(field))) {
      throw new DomainError("CONFIGURATION_INVALID", "Trusted evidence key contains an unsupported field");
    }
    const allowedScopes = stringList(record.allowedScopes, "allowedScopes", 100, 512);
    const allowedEnvironments = enumList(
      record.allowedEnvironments,
      "allowedEnvironments",
      ["test", "sandbox", "staging", "production"] as const,
    );
    return {
      issuer: requiredString(record.issuer, "issuer", 128),
      provider: requiredString(record.provider, "provider", 128),
      keyId: requiredString(record.keyId, "keyId", 128),
      algorithm: enumValue(record.algorithm, "algorithm", ["Ed25519"] as const),
      publicKeyPem: requiredPem(record.publicKeyPem),
      allowedScopes,
      allowedEnvironments,
      ...(record.notBefore === undefined ? {} : { notBefore: requiredString(record.notBefore, "notBefore", 64) }),
      ...(record.notAfter === undefined ? {} : { notAfter: requiredString(record.notAfter, "notAfter", 64) }),
    };
  });
}

function parseTrustedConsentPolicyKeys(serialized: string | undefined): readonly TrustedConsentPolicyKey[] {
  if (serialized === undefined || serialized.trim().length === 0) {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_CONSENT_POLICY_TRUST_KEYS_JSON is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_CONSENT_POLICY_TRUST_KEYS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    throw new DomainError("CONFIGURATION_INVALID", "Consent policy trust must contain one to 100 keys");
  }
  return parsed.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new DomainError("CONFIGURATION_INVALID", "Each consent policy trust key must be an object");
    }
    const record = value as Record<string, unknown>;
    const allowedFields = new Set([
      "keyId", "issuer", "algorithm", "publicKeyPem", "allowedEnvironments", "notBefore", "notAfter", "revokedAt",
    ]);
    if (Object.keys(record).some((field) => !allowedFields.has(field))) {
      throw new DomainError("CONFIGURATION_INVALID", "Consent policy trust key contains an unsupported field");
    }
    return {
      keyId: requiredString(record.keyId, "consent policy keyId", 128),
      issuer: requiredString(record.issuer, "consent policy issuer", 128),
      algorithm: enumValue(record.algorithm, "consent policy algorithm", ["Ed25519"] as const),
      publicKeyPem: requiredPem(record.publicKeyPem),
      allowedEnvironments: enumList(
        record.allowedEnvironments,
        "consent policy allowedEnvironments",
        ["sandbox", "staging", "production"] as const,
      ),
      notBefore: requiredString(record.notBefore, "consent policy notBefore", 64),
      notAfter: requiredString(record.notAfter, "consent policy notAfter", 64),
      ...(record.revokedAt === undefined || record.revokedAt === null
        ? {}
        : { revokedAt: requiredString(record.revokedAt, "consent policy revokedAt", 64) }),
    };
  });
}

function readBoundedJsonFile(path: string, label: string, maximumBytes: number): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > maximumBytes) {
      throw new DomainError("CONFIGURATION_INVALID", `${label} must be a bounded regular file`);
    }
    const serialized = readFileSync(descriptor, { encoding: "utf8" });
    const parsed = JSON.parse(serialized) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DomainError("CONFIGURATION_INVALID", `${label} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("CONFIGURATION_INVALID", `${label} could not be read as bounded JSON`, {
      details: { cause: error instanceof Error ? error.name : "unknown" },
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertDigestOnlyProductionTokens(serialized: string | undefined): void {
  if (serialized === undefined || serialized.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return;
  }
  if (Array.isArray(parsed) && parsed.some((value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) && "token" in value)) {
    throw new DomainError("CONFIGURATION_INVALID", "Production API principals must use tokenSha256, not plaintext token");
  }
}

function resolveProductPath(value: string, productRoot: string): string {
  if (value === ":memory:") return value;
  return resolve(isAbsolute(value) ? value : resolve(productRoot, value));
}

function optionalDigest(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function integerValue(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function visibleValue(value: string, label: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new DomainError("CONFIGURATION_INVALID", `${label} must be a string`);
  return visibleValue(value.trim(), label, maximum);
}

function requiredPem(value: unknown): string {
  if (typeof value !== "string" || value.length < 80 || value.length > 8_192 || !value.includes("BEGIN PUBLIC KEY")) {
    throw new DomainError("CONFIGURATION_INVALID", "publicKeyPem must be a PEM public key");
  }
  return value;
}

function stringList(value: unknown, label: string, maximumItems: number, maximumLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be a non-empty bounded array`);
  }
  const values = value.map((item) => requiredString(item, label, maximumLength));
  if (new Set(values).size !== values.length) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must not contain duplicates`);
  }
  return values;
}

function enumList<T extends string>(value: unknown, label: string, allowed: readonly T[]): readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !allowed.includes(item as T))) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} contains an unsupported value`);
  }
  const result = value as T[];
  if (new Set(result).size !== result.length) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must not contain duplicates`);
  }
  return [...result];
}

function enumValue<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
