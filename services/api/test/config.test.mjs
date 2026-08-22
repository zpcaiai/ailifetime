import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { DomainError } from "@ltm/core";
import { loadApiConfiguration } from "../dist/index.js";

const productRoot = "/tmp/ltm-product-root";

function productionEnvironment(overrides = {}) {
  const { publicKey } = generateKeyPairSync("ed25519");
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
    LTM_METRICS_TOKEN_SHA256: metricsTokenSha256,
    LTM_DATABASE_PATH: ".data/production.sqlite",
    ...overrides,
  };
}

function expectConfigurationError(environment) {
  assert.throws(
    () => loadApiConfiguration(environment, productRoot),
    (error) => error instanceof DomainError && error.code === "CONFIGURATION_INVALID",
  );
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
  }, productRoot);
  assert.equal(configuration.runtimeOptions.evidenceEnvironment, "sandbox");
  assert.equal(configuration.allowSandboxStepUpHeader, true);
  assert.equal(configuration.runtimeOptions.databasePath, `${productRoot}/.data/ltm-local.sqlite`);
});

test("production accepts pinned OIDC/JWKS without the static-token exception", () => {
  const configuration = loadApiConfiguration(productionEnvironment({
    LTM_AUTH_MODE: "oidc",
    LTM_ALLOW_STATIC_TOKEN_AUTH: "false",
    LTM_OIDC_ISSUER: "https://identity.example.test",
    LTM_OIDC_AUDIENCE: "ltm-api",
    LTM_OIDC_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
    LTM_OIDC_ALGORITHMS: "RS256,ES256",
    LTM_OIDC_ROLE_MAP_JSON: JSON.stringify({ "ltm-service": "service_account" }),
  }), productRoot);
  assert.equal(configuration.authMode, "oidc");
});

test("distributed production selects PostgreSQL and requires OIDC plus verified TLS", () => {
  const environment = productionEnvironment({
    LTM_DEPLOYMENT_PROFILE: "distributed",
    LTM_AUTH_MODE: "oidc",
    LTM_DATABASE_PATH: undefined,
    DATABASE_URL: "postgresql://ltm_runtime@db.example.test/lifetime?sslmode=verify-full",
    LTM_OIDC_ISSUER: "https://identity.example.test",
    LTM_OIDC_AUDIENCE: "ltm-api",
    LTM_OIDC_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
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
