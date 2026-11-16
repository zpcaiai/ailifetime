import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { signConsentPolicyCatalog } from "@ltm/core";
import { createVercelHandler, loadVercelStartupConfiguration,
  materializeVercelConfiguration, vercelRuntimeEnvironment } from "../dist/vercel-handler.js";

const previewDb = "postgresql://preview:fixture@preview-db.example.test/preview?sslmode=verify-full";
const keyPair = generateKeyPairSync("ed25519");
const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const issuedAt = new Date(Date.now() - 60_000).toISOString();
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function fixture(policyEnvironment = "staging", vercelEnvironment = "preview") {
  const catalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1", catalogId: "staging-crypto-test",
    issuer: "privacy-test-authority", environment: policyEnvironment, algorithm: "Ed25519",
    keyId: "consent-test-key", issuedAt, expiresAt,
    policies: [{ policyVersion: "age-transform-cn-test-v1", purpose: "age_transformation",
      locale: "zh-CN", jurisdictions: ["CN"], resourceKinds: ["media.asset"],
      allowedActions: ["ingest"], grantorCapacities: ["self"], minorApplicability: "all",
      disclosureSha256: "a".repeat(64), effectiveFrom: issuedAt, effectiveUntil: expiresAt,
      maxConsentLifetimeSeconds: 3600 }],
  }, privateKeyPem);
  return {
    VERCEL_ENV: vercelEnvironment, LTM_VERCEL_PREVIEW_PROFILE: "staging",
    DATABASE_URL: "postgresql://production:fixture@database.example.test/neondb?sslmode=verify-full",
    LTM_MINIAPP_PREVIEW_DATABASE_URL: previewDb,
    LTM_AUTH_MODE: "oidc", LTM_OIDC_ISSUER: "https://identity.example.test",
    LTM_OIDC_AUDIENCE: "ailifetime-miniapp-preview",
    LTM_OIDC_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
    LTM_EVIDENCE_TRUST_KEYS_JSON: JSON.stringify([{
      issuer: "evidence-test-authority", provider: "scanner-fixture", keyId: "evidence-test-key",
      algorithm: "Ed25519", publicKeyPem, allowedScopes: ["ltm-evidence:v1:" + "b".repeat(64)],
      allowedEnvironments: [policyEnvironment],
    }]),
    LTM_CONSENT_POLICY_CATALOG_JSON: JSON.stringify(catalog),
    LTM_CONSENT_POLICY_TRUST_KEYS_JSON: JSON.stringify([{
      issuer: "privacy-test-authority", keyId: "consent-test-key", algorithm: "Ed25519",
      publicKeyPem, allowedEnvironments: [policyEnvironment], notBefore: issuedAt, notAfter: expiresAt,
    }]),
    LTM_CONSENT_POLICY_JURISDICTION: "CN", LTM_CONSENT_POLICY_LOCALE: "zh-CN",
    LTM_METRICS_TOKEN_SHA256: "c".repeat(64),
    LTM_WECHAT_IDENTITY_BROKER_URL: "https://identity.example.test",
    LTM_WECHAT_IDENTITY_TOKEN: "fixture-wechat-identity-token",
    LTM_WECHAT_PLATFORM_BROKER_URL: "https://platform.example.test",
    LTM_WECHAT_PLATFORM_BROKER_TOKEN: "fixture-wechat-platform-token",
    LTM_WECHAT_CUSTOMER_SERVICE_ALLOWED_ORIGINS: "https://service.example.test",
    LTM_UPLOAD_BROKER_URL: "https://upload.example.test",
    LTM_UPLOAD_BROKER_TOKEN: "fixture-upload-token",
    LTM_PHOTO_S3_ENDPOINT: "https://production-objects.example.test",
    LTM_PHOTO_S3_BUCKET: "production-photos",
    LTM_MINIAPP_PREVIEW_PHOTO_S3_ENDPOINT: "https://preview-objects.example.test",
    LTM_MINIAPP_PREVIEW_PHOTO_S3_REGION: "ap-southeast-1",
    LTM_MINIAPP_PREVIEW_PHOTO_S3_BUCKET: "miniapp-preview-photos",
    LTM_MINIAPP_PREVIEW_PHOTO_S3_ACCESS_KEY_ID: "fixture-preview-key",
    LTM_MINIAPP_PREVIEW_PHOTO_S3_SECRET_ACCESS_KEY: "fixture-preview-secret",
  };
}

async function load(environment) {
  const materialized = await materializeVercelConfiguration(vercelRuntimeEnvironment(environment));
  try { return loadVercelStartupConfiguration(materialized.environment, process.cwd(), environment); }
  finally { await materialized.close(); }
}

test("explicit Preview staging uses the isolated DB and real staging signature verification", async () => {
  const config = await load(fixture());
  assert.equal(config.appEnvironment, "staging");
  assert.equal(config.postgresRuntimeOptions.connectionString, previewDb);
  assert.equal(config.postgresRuntimeOptions.evidenceEnvironment, "staging");
  assert.equal(config.postgresRuntimeOptions.consentPolicyCatalog.environment, "staging");
  assert.ok(config.clientIntegrations.wechatPlatform && config.clientIntegrations.resumableUploads);
});

test("staging rejects a production-signed catalog and a tampered staging catalog", async () => {
  await assert.rejects(load(fixture("production")), /catalog environment does not match/);
  const env = fixture();
  const catalog = JSON.parse(env.LTM_CONSENT_POLICY_CATALOG_JSON);
  catalog.policies[0].disclosureSha256 = "e".repeat(64);
  env.LTM_CONSENT_POLICY_CATALOG_JSON = JSON.stringify(catalog);
  await assert.rejects(load(env), /signature/);
});

test("Preview without opt-in and production deployments retain production verification", async () => {
  const env = fixture();
  delete env.LTM_VERCEL_PREVIEW_PROFILE;
  assert.equal(vercelRuntimeEnvironment(env).DATABASE_URL, env.DATABASE_URL);
  await assert.rejects(load(env), /catalog environment does not match/);
  const production = await load(fixture("production", "production"));
  assert.equal(production.appEnvironment, "production");
  assert.equal(production.postgresRuntimeOptions.evidenceEnvironment, "production");
  assert.equal(production.postgresRuntimeOptions.consentPolicyCatalog.environment, "production");
});

test("staging refuses wrong database, missing broker, or cross-environment trust", async () => {
  const wrongDb = fixture();
  wrongDb.LTM_MINIAPP_PREVIEW_DATABASE_URL = wrongDb.DATABASE_URL;
  await assert.rejects(load(wrongDb), /STAGING_PREVIEW_CONFIGURATION_INVALID/);
  const wrongBucket = fixture();
  wrongBucket.LTM_MINIAPP_PREVIEW_PHOTO_S3_ENDPOINT = wrongBucket.LTM_PHOTO_S3_ENDPOINT + "/";
  wrongBucket.LTM_MINIAPP_PREVIEW_PHOTO_S3_BUCKET = wrongBucket.LTM_PHOTO_S3_BUCKET;
  await assert.rejects(load(wrongBucket), /STAGING_PREVIEW_CONFIGURATION_INVALID/);
  const missingSecret = fixture();
  delete missingSecret.LTM_MINIAPP_PREVIEW_PHOTO_S3_SECRET_ACCESS_KEY;
  missingSecret.LTM_PHOTO_S3_SECRET_ACCESS_KEY = "fixture-production-secret";
  assert.equal(vercelRuntimeEnvironment(missingSecret).LTM_PHOTO_S3_SECRET_ACCESS_KEY, undefined);
  await assert.rejects(load(missingSecret), /CONFIGURATION_INVALID/);
  const missingBroker = fixture();
  delete missingBroker.LTM_UPLOAD_BROKER_URL;
  await assert.rejects(load(missingBroker), /CONFIGURATION_INVALID/);
  const wrongTrust = fixture();
  const keys = JSON.parse(wrongTrust.LTM_EVIDENCE_TRUST_KEYS_JSON);
  keys[0].allowedEnvironments.push("production");
  wrongTrust.LTM_EVIDENCE_TRUST_KEYS_JSON = JSON.stringify(keys);
  await assert.rejects(load(wrongTrust), /STAGING_PREVIEW_TRUST_SCOPE_INVALID/);
});

test("missing staging consent keeps the actual readiness route at 503", async () => {
  const env = fixture();
  for (const name of ["LTM_CONSENT_POLICY_CATALOG_JSON", "LTM_CONSENT_POLICY_TRUST_KEYS_JSON",
    "LTM_CONSENT_POLICY_JURISDICTION", "LTM_CONSENT_POLICY_LOCALE"]) delete env[name];
  const app = createVercelHandler(env, process.cwd());
  const server = createServer(app.handler);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/health/ready");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "BACKEND_NOT_CONFIGURED");
  } finally {
    server.close();
    await app.close();
  }
});
