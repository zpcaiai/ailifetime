import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, signConsentPolicyCatalog } from "@ltm/core";
import { loadApiConfiguration } from "../dist/index.js";

const productRoot = mkdtempSync(join(tmpdir(), "ltm-api-config-"));
after(() => rmSync(productRoot, { recursive: true, force: true }));

function productionEnvironment(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const policyIssuedAt = new Date(Date.now() - 60_000).toISOString();
  const policyExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const policyCatalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "api-production-policy-1",
    issuer: "privacy-policy-authority",
    environment: "production",
    issuedAt: policyIssuedAt,
    expiresAt: policyExpiresAt,
    algorithm: "Ed25519",
    keyId: "api-consent-key-1",
    policies: [{
      policyVersion: "api-policy-v1",
      purpose: "product_operation",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["record"],
      allowedActions: ["read"],
      grantorCapacities: ["self"],
      minorApplicability: "adult",
      disclosureSha256: "d".repeat(64),
      effectiveFrom: policyIssuedAt,
      effectiveUntil: policyExpiresAt,
      maxConsentLifetimeSeconds: 3_600,
    }],
  }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const policyFile = join(productRoot, "consent-policy.json");
  writeFileSync(policyFile, JSON.stringify(policyCatalog), { mode: 0o600 });
  const tokenSha256 = createHash("sha256").update("production-token-value-0001").digest("hex");
  const metricsTokenSha256 = createHash("sha256").update("metrics-token-value-0001").digest("hex");
  return {
    APP_ENV: "production",
    LTM_AUTH_MODE: "configured-tokens",
    LTM_DEPLOYMENT_PROFILE: "single-node",
    LTM_ALLOW_SINGLE_NODE_SQLITE: "true",
    LTM_ALLOW_STATIC_TOKEN_AUTH: "true",
    LTM_API_TOKENS_JSON: JSON.stringify([{
      tokenSha256,
      actorId: "service-production",
      tenantId: "tenant-production",
      roles: ["service_account"],
      permissions: ["record:create"],
      allowedPurposes: ["product_operation"],
    }]),
    LTM_EVIDENCE_TRUST_KEYS_JSON: JSON.stringify([{
      issuer: "production-issuer",
      provider: "production-provider",
      keyId: "production-key-1",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: ["B127:*"],
      allowedEnvironments: ["production"],
    }]),
    LTM_CONSENT_POLICY_CATALOG_FILE: policyFile,
    LTM_CONSENT_POLICY_TRUST_KEYS_JSON: JSON.stringify([{
      keyId: "api-consent-key-1",
      issuer: "privacy-policy-authority",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedEnvironments: ["production"],
      notBefore: policyIssuedAt,
      notAfter: policyExpiresAt,
    }]),
    LTM_CONSENT_POLICY_JURISDICTION: "CN",
    LTM_CONSENT_POLICY_LOCALE: "zh-CN",
    LTM_METRICS_TOKEN_SHA256: metricsTokenSha256,
    LTM_DATABASE_PATH: ".data/production.sqlite",
    LTM_WECHAT_IDENTITY_BROKER_URL: "https://identity-broker.example.test",
    LTM_WECHAT_IDENTITY_TOKEN_FILE: "/var/run/secrets/ltm/wechat-identity-token",
    LTM_UPLOAD_BROKER_URL: "https://upload-broker.example.test",
    LTM_UPLOAD_BROKER_TOKEN_FILE: "/var/run/secrets/ltm/upload-broker-token",
    ...overrides,
  };
}

function expectConfigurationError(environment) {
  assert.throws(
    () => loadApiConfiguration(environment, productRoot),
    (error) => error instanceof DomainError && error.code === "CONFIGURATION_INVALID",
  );
}

function browserOidcEnvironment(overrides = {}) {
  return {
    LTM_OIDC_ISSUER: "https://identity.example.test",
    LTM_OIDC_AUDIENCE: "ltm-api",
    LTM_OIDC_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
    LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT: "https://identity.example.test/oauth2/authorize",
    LTM_WEB_OIDC_TOKEN_ENDPOINT: "https://identity.example.test/oauth2/token",
    LTM_WEB_OIDC_CLIENT_ID: "ltm-production-spa",
    LTM_WEB_OIDC_REDIRECT_URI: "https://ltm.example.test/auth/callback",
    LTM_WEB_OIDC_SCOPES: "openid profile email",
    LTM_PUBLIC_BASE_URL: "https://ltm.example.test",
    ...overrides,
  };
}

test("production configuration is root-relative, digest-only, and evidence environment bound", () => {
  const configuration = loadApiConfiguration(productionEnvironment(), productRoot);
  assert.equal(configuration.appEnvironment, "production");
  assert.equal(configuration.runtimeOptions.databasePath, `${productRoot}/.data/production.sqlite`);
  assert.equal(configuration.runtimeOptions.evidencePolicy, "production");
  assert.equal(configuration.runtimeOptions.evidenceEnvironment, "production");
  assert.equal(configuration.runtimeOptions.trustedEvidenceKeys?.[0]?.allowedEnvironments[0], "production");
  assert.equal(configuration.port, 8080);
  assert.match(configuration.metricsTokenSha256 ?? "", /^[a-f0-9]{64}$/);
});

test("production refuses synthetic auth, plaintext long-lived tokens, missing trust, and unprotected metrics", () => {
  expectConfigurationError(productionEnvironment({ LTM_AUTH_MODE: "local-synthetic-only" }));
  expectConfigurationError(productionEnvironment({ LTM_DEPLOYMENT_PROFILE: "distributed" }));
  expectConfigurationError(productionEnvironment({ LTM_ALLOW_SINGLE_NODE_SQLITE: "false" }));
  expectConfigurationError(productionEnvironment({ LTM_ALLOW_STATIC_TOKEN_AUTH: "false" }));
  expectConfigurationError(productionEnvironment({
    LTM_API_TOKENS_JSON: JSON.stringify([{
      token: "plaintext-production-token-0001",
      actorId: "admin",
      tenantId: "tenant",
      roles: ["platform_admin"],
      allowedPurposes: ["*"],
    }]),
  }));
  expectConfigurationError(productionEnvironment({ LTM_EVIDENCE_TRUST_KEYS_JSON: "[]" }));
  expectConfigurationError(productionEnvironment({ LTM_METRICS_TOKEN_SHA256: "" }));
  expectConfigurationError(productionEnvironment({ LTM_DATABASE_PATH: ":memory:" }));
  expectConfigurationError(productionEnvironment({ LTM_WECHAT_IDENTITY_BROKER_URL: undefined }));
  expectConfigurationError(productionEnvironment({ LTM_UPLOAD_BROKER_TOKEN_FILE: undefined }));
  expectConfigurationError(productionEnvironment({
    LTM_CONSENT_POLICY_CATALOG_FILE: undefined,
    LTM_CONSENT_POLICY_TRUST_KEYS_JSON: undefined,
    LTM_CONSENT_POLICY_JURISDICTION: undefined,
    LTM_CONSENT_POLICY_LOCALE: undefined,
  }));
  expectConfigurationError(productionEnvironment({ LTM_CONSENT_POLICY_TRUST_KEYS_JSON: undefined }));
  expectConfigurationError(productionEnvironment({ LTM_CONSENT_POLICY_JURISDICTION: undefined }));
  expectConfigurationError(productionEnvironment({ LTM_CONSENT_POLICY_LOCALE: undefined }));
  expectConfigurationError(productionEnvironment({ LTM_ALLOW_LEGACY_CONSENT_POLICY: "true" }));
});

test("API verifier refuses signing private keys and malformed trust manifests", () => {
  expectConfigurationError({
    APP_ENV: "local",
    LTM_AUTH_MODE: "local-synthetic-only",
    LTM_EVIDENCE_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY----- secret", // secret-scan: allow-test-fixture
  });
  expectConfigurationError({
    APP_ENV: "staging",
    LTM_AUTH_MODE: "local-synthetic-only",
  });
  expectConfigurationError({
    APP_ENV: "local",
    LTM_AUTH_MODE: "local-synthetic-only",
    LTM_EVIDENCE_TRUST_KEYS_JSON: JSON.stringify([{ privateKeyPem: "forbidden" }]),
  });
});

test("local synthetic configuration remains explicit and sandbox scoped", () => {
  const configuration = loadApiConfiguration({
    APP_ENV: "local",
    LTM_AUTH_MODE: "local-synthetic-only",
    LTM_SANDBOX_STEP_UP_HEADER: "true",
    LTM_ALLOW_LEGACY_CONSENT_POLICY: "true",
  }, productRoot);
  assert.equal(configuration.runtimeOptions.evidenceEnvironment, "sandbox");
  assert.equal(configuration.runtimeOptions.allowLegacyConsentPolicy, true);
  assert.equal(configuration.allowSandboxStepUpHeader, true);
  assert.equal(configuration.runtimeOptions.databasePath, `${productRoot}/.data/ltm-local.sqlite`);
  assert.equal(configuration.browserOidcConfiguration, undefined);
});

test("production accepts pinned OIDC/JWKS without the static-token exception", () => {
  const configuration = loadApiConfiguration(productionEnvironment({
    LTM_AUTH_MODE: "oidc",
    LTM_ALLOW_STATIC_TOKEN_AUTH: "false",
    ...browserOidcEnvironment(),
    LTM_OIDC_ALGORITHMS: "RS256,ES256",
    LTM_OIDC_ROLE_MAP_JSON: JSON.stringify({ "ltm-service": "service_account" }),
  }), productRoot);
  assert.equal(configuration.authMode, "oidc");
  assert.equal(configuration.browserOidcConfiguration?.redirectUri, "https://ltm.example.test/auth/callback");
});

test("production browser OIDC fails closed on missing, drifting, or refresh-capable public SPA configuration", () => {
  const base = productionEnvironment({
    LTM_AUTH_MODE: "oidc",
    LTM_ALLOW_STATIC_TOKEN_AUTH: "false",
    ...browserOidcEnvironment(),
  });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_TOKEN_ENDPOINT: undefined });
  expectConfigurationError({ ...base, LTM_OIDC_JWKS_URL: "https://keys.example.test/.well-known/jwks.json" });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_TOKEN_ENDPOINT: "https://tokens.example.test/oauth2/token" });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT: "http://identity.example.test/oauth2/authorize" });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_REDIRECT_URI: "https://ltm.example.test/auth/callback?next=/" });
  expectConfigurationError({ ...base, LTM_PUBLIC_BASE_URL: undefined });
  expectConfigurationError({ ...base, LTM_PUBLIC_BASE_URL: "https://other.example.test" });
  expectConfigurationError({ ...base, LTM_PUBLIC_BASE_URL: "https://ltm.example.test/base" });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_REDIRECT_URI: "https://other.example.test/auth/callback" });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_REDIRECT_URI: "https://ltm.example.test/oidc/callback" });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_SCOPES: "openid profile offline_access" });
  expectConfigurationError({ ...base, LTM_WEB_OIDC_CLIENT_ID: "client id with spaces" });
});

test("distributed production selects PostgreSQL and requires OIDC plus verified TLS", () => {
  const environment = productionEnvironment({
    LTM_DEPLOYMENT_PROFILE: "distributed",
    LTM_AUTH_MODE: "oidc",
    LTM_DATABASE_PATH: undefined,
    DATABASE_URL: "postgresql://ltm_runtime@db.example.test/lifetime?sslmode=verify-full",
    ...browserOidcEnvironment(),
  });
  const configuration = loadApiConfiguration(environment, productRoot);
  assert.equal(configuration.deploymentProfile, "distributed");
  assert.equal(configuration.postgresRuntimeOptions?.connectionString, environment.DATABASE_URL);
  assert.equal(configuration.postgresRuntimeOptions?.evidencePolicy, "production");

  expectConfigurationError({ ...environment, DATABASE_URL: undefined });
  expectConfigurationError({
    ...environment,
    DATABASE_URL: "postgresql://ltm_runtime@db.example.test/lifetime?sslmode=disable",
  });
  expectConfigurationError({ ...environment, LTM_AUTH_MODE: "configured-tokens" });
  expectConfigurationError({ ...environment, LTM_DATABASE_PATH: ".data/ambiguous.sqlite" });
});
