import assert from "node:assert/strict";
import test from "node:test";
import { ProductionIntegrationError } from "@ltm/providers";
import { loadIntegrationGatewayConfiguration } from "./config.js";

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: "sandbox",
    LTM_TENANT_ID: "tenant-1",
    LTM_REDIS_URL: "redis://127.0.0.1:6379",
    LTM_EVIDENCE_S3_BUCKET: "ltm-evidence-sandbox",
    LTM_EVIDENCE_S3_KMS_KEY_ID: "arn:aws:kms:us-east-1:111122223333:key/synthetic",
    LTM_EVIDENCE_ISSUER: "sandbox:integration-gateway",
    LTM_EVIDENCE_KEY_ID: "sandbox-key-1",
    LTM_EVIDENCE_PRIVATE_KEY_REFERENCE: "secret-manager:ltm/sandbox/evidence-key",
    LTM_API_COMMAND_URL: "https://api.example.test/v1/commands",
    LTM_API_BEARER_TOKEN_FILE: "/var/run/secrets/ltm/api-token",
    LTM_COMMERCE_BINDING_URL: "https://commerce.example.test/v1/resolve",
    LTM_COMMERCE_BINDING_SIGNING_KEY_REFERENCE: "secret-manager:ltm/sandbox/commerce-signing",
    LTM_COMMERCE_BINDING_RESPONSE_KEY_REFERENCE: "secret-manager:ltm/sandbox/commerce-response",
    LTM_COMMERCE_BINDING_RESPONSE_SIGNATURE_SCHEME: "hmac-sha256",
    LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE: "secret-manager:ltm/sandbox/partner-policies",
  };
}

test("gateway accepts managed references and makes Google ADC the default", () => {
  const environment = baseEnvironment();
  delete environment.LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE;
  Object.assign(environment, {
    LTM_GOOGLE_CALLBACKS_ENABLED: "true",
    LTM_GOOGLE_PLAY_PACKAGE_NAME: "com.example.ailifetime",
    LTM_GOOGLE_PUBSUB_AUDIENCE: "https://gateway.example.test/v1/callbacks/google-play",
    LTM_GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@project.iam.gserviceaccount.com",
    LTM_GOOGLE_PUBSUB_SUBSCRIPTION: "projects/project/subscriptions/google-play",
  });
  const configuration = loadIntegrationGatewayConfiguration(environment);
  assert.equal(configuration.google?.authMode, "adc");
  assert.equal(configuration.google?.serviceAccountCredentialReference, undefined);
  assert.equal(configuration.output.purpose, "external_business_event_projection");
});

test("production gateway rejects non-production issuer, plaintext Redis, and inline secrets", () => {
  for (const mutation of ["issuer", "redis", "inline"] as const) {
    const environment = baseEnvironment();
    environment.APP_ENV = "production";
    environment.LTM_EVIDENCE_ISSUER = "prod:integration-gateway";
    environment.LTM_REDIS_URL = "rediss://redis.example.test:6380";
    if (mutation === "issuer") environment.LTM_EVIDENCE_ISSUER = "test:forged-production";
    if (mutation === "redis") environment.LTM_REDIS_URL = "redis://redis.example.test:6379";
    if (mutation === "inline") environment.LTM_EVIDENCE_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----"; // secret-scan: allow-test-fixture
    assert.throws(() => loadIntegrationGatewayConfiguration(environment), (error: unknown) =>
      error instanceof ProductionIntegrationError && error.code === "CONFIGURATION_INVALID");
  }
});

test("production gateway requires the managed 19-route external-command policy inventory", () => {
  const environment = baseEnvironment();
  environment.APP_ENV = "production";
  environment.LTM_EVIDENCE_ISSUER = "prod:integration-gateway";
  environment.LTM_REDIS_URL = "rediss://redis.example.test:6380";
  delete environment.LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE;
  Object.assign(environment, {
    LTM_GOOGLE_CALLBACKS_ENABLED: "true",
    LTM_GOOGLE_PLAY_PACKAGE_NAME: "com.example.ailifetime",
    LTM_GOOGLE_PUBSUB_AUDIENCE: "https://gateway.example.test/v1/callbacks/google-play",
    LTM_GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@project.iam.gserviceaccount.com",
    LTM_GOOGLE_PUBSUB_SUBSCRIPTION: "projects/project/subscriptions/google-play",
  });
  assert.throws(
    () => loadIntegrationGatewayConfiguration(environment),
    /complete managed external-command partner policy inventory/,
  );
});

test("gateway rejects implicit managed Google key and incomplete Apple production trust", () => {
  const google = baseEnvironment();
  delete google.LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE;
  Object.assign(google, {
    LTM_GOOGLE_CALLBACKS_ENABLED: "true",
    LTM_GOOGLE_PLAY_PACKAGE_NAME: "com.example.ailifetime",
    LTM_GOOGLE_PUBSUB_AUDIENCE: "https://gateway.example.test/v1/callbacks/google-play",
    LTM_GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@project.iam.gserviceaccount.com",
    LTM_GOOGLE_PUBSUB_SUBSCRIPTION: "projects/project/subscriptions/google-play",
    LTM_GOOGLE_SERVICE_ACCOUNT_REFERENCE: "secret-manager:ltm/google/key",
  });
  assert.throws(() => loadIntegrationGatewayConfiguration(google), /managed-service-account/);

  const apple = baseEnvironment();
  apple.APP_ENV = "production";
  apple.LTM_REDIS_URL = "rediss://redis.example.test:6380";
  apple.LTM_EVIDENCE_ISSUER = "prod:integration-gateway";
  delete apple.LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE;
  Object.assign(apple, {
    LTM_APPLE_CALLBACKS_ENABLED: "true",
    LTM_APPLE_BUNDLE_ID: "com.example.ailifetime",
    LTM_APPLE_ROOT_CERTIFICATE_REFERENCES: "secret-manager:ltm/apple/root",
    LTM_APPLE_ONLINE_CERTIFICATE_CHECKS: "false",
  });
  assert.throws(() => loadIntegrationGatewayConfiguration(apple), /online certificate checks/);
});
