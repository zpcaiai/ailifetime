import assert from "node:assert/strict";
import test from "node:test";
import { BrokerError } from "./contracts.js";
import { loadBrokerConfiguration } from "./config.js";

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "8443",
    LTM_BROKER_TLS_CERT_FILE: "/var/run/secrets/ltm-broker-tls/tls.crt",
    LTM_BROKER_TLS_KEY_FILE: "/var/run/secrets/ltm-broker-tls/tls.key",
    LTM_BROKER_TLS_CA_FILE: "/var/run/secrets/ltm-broker-tls/ca.crt",
    LTM_BROKER_WORKLOAD_TOKEN_SHA256S: "a".repeat(64),
    LTM_WECHAT_APP_ID: "wx0123456789abcdef",
    LTM_WECHAT_APP_SECRET_FILE: "/var/run/secrets/ltm-broker-credentials/wechat-app-secret",
    LTM_ENTERPRISE_IDP_URL: "https://identity.example.com",
    LTM_ENTERPRISE_IDP_TOKEN_FILE: "/var/run/secrets/ltm-broker-credentials/idp-token",
    LTM_BROKER_REDIS_URL: "rediss://broker:credential@redis.example.com:6380/0", // secret-scan: allow-test-fixture
    LTM_MEDIA_S3_BUCKET: "ltm-production-media",
    LTM_MEDIA_S3_REGION: "us-east-1",
    LTM_MEDIA_S3_KMS_KEY_ID: "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    LTM_MEDIA_S3_PREFIX: "media/v1",
    LTM_MEDIA_SAFETY_SCANNER_URL: "https://media-safety.example.com",
    LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE: "/var/run/secrets/ltm-broker-credentials/media-scanner-token",
    LTM_MEDIA_SAFETY_RECEIPT_PUBLIC_KEY_FILE: "/etc/ltm/media-safety/receipt.pub",
    LTM_MEDIA_SAFETY_EXPECTED_PROVIDER: "production-media-scanner",
    LTM_MEDIA_SAFETY_EXPECTED_POLICY_ID: "media-safety-policy-v4",
    LTM_MEDIA_SAFETY_POLICY_SHA256: "b".repeat(64),
    LTM_MEDIA_SAFETY_EXPECTED_MODEL_VERSION: "scanner-model-2026-08",
    LTM_MEDIA_SAFETY_EXPECTED_KEY_ID: "media-safety-receipt-key-1",
    LTM_MEDIA_SAFETY_EXPECTED_ENVIRONMENT: "production",
    LTM_MEDIA_LIFECYCLE_CATALOG_FILE: "/etc/ltm/media-lifecycle/catalog.json",
    LTM_MEDIA_LIFECYCLE_TRUST_PUBLIC_KEY_FILE: "/etc/ltm/media-lifecycle/catalog-signing.pub",
    LTM_MEDIA_LIFECYCLE_EXPECTED_KEY_ID: "media-policy-production-1",
    LTM_MEDIA_LIFECYCLE_EXPECTED_ISSUER: "ltm-privacy-policy-authority",
    LTM_MEDIA_LIFECYCLE_EXPECTED_ENVIRONMENT: "production",
    LTM_MEDIA_LIFECYCLE_TARGET_SECRET_ROOT: "/var/run/secrets/ltm-media-lifecycle-targets",
    LTM_MEDIA_DOWNLOAD_PRIVATE_KEY_FILE: "/var/run/secrets/ltm-media-download/signing.key",
    LTM_MEDIA_DOWNLOAD_PUBLIC_KEY_FILE: "/etc/ltm/media-download/signing.pub",
    LTM_MEDIA_DOWNLOAD_BASE_URL: "https://media.example.com",
    LTM_MEDIA_DOWNLOAD_ISSUER: "ltm-media-broker",
    LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS: "tenant-production-1",
  };
}

test("production configuration requires TLS Redis, HTTPS IdP, projected secrets, and server TLS", () => {
  const configuration = loadBrokerConfiguration(productionEnvironment());
  assert.equal(configuration.port, 8443);
  assert.equal(configuration.redisUrl.startsWith("rediss://"), true);
  assert.equal(configuration.identityProviderUrl, "https://identity.example.com");
  assert.equal(configuration.tlsCertificateAuthorityFile, "/var/run/secrets/ltm-broker-tls/ca.crt");
  assert.equal(configuration.mediaSafetyScannerUrl, "https://media-safety.example.com");
  assert.equal(configuration.mediaSafetyPolicySha256, "b".repeat(64));
  assert.equal(configuration.mediaLifecycleExpectedKeyId, "media-policy-production-1");
  assert.deepEqual(configuration.mediaLifecycleMaintenanceTenantIds, ["tenant-production-1"]);
});

test("production lifecycle policy, download signing, and maintenance tenancy are mandatory and paired", () => {
  for (const remove of [
    "LTM_MEDIA_LIFECYCLE_CATALOG_FILE",
    "LTM_MEDIA_LIFECYCLE_TRUST_PUBLIC_KEY_FILE",
    "LTM_MEDIA_LIFECYCLE_EXPECTED_KEY_ID",
    "LTM_MEDIA_LIFECYCLE_EXPECTED_ISSUER",
    "LTM_MEDIA_LIFECYCLE_EXPECTED_ENVIRONMENT",
    "LTM_MEDIA_LIFECYCLE_TARGET_SECRET_ROOT",
    "LTM_MEDIA_DOWNLOAD_PRIVATE_KEY_FILE",
    "LTM_MEDIA_DOWNLOAD_PUBLIC_KEY_FILE",
    "LTM_MEDIA_DOWNLOAD_BASE_URL",
    "LTM_MEDIA_DOWNLOAD_ISSUER",
    "LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS",
  ]) {
    const environment = productionEnvironment();
    delete environment[remove];
    assert.throws(
      () => loadBrokerConfiguration(environment),
      (error: unknown) => error instanceof BrokerError && error.code === "CONFIGURATION_INVALID",
    );
  }
});

test("media scanner configuration is paired, HTTPS-only, and uses a projected credential", () => {
  const configured = productionEnvironment();
  const configuration = loadBrokerConfiguration(configured);
  assert.equal(configuration.mediaSafetyScannerUrl, "https://media-safety.example.com");
  assert.equal(configuration.mediaSafetyScannerTokenFile, "/var/run/secrets/ltm-broker-credentials/media-scanner-token");

  for (const environment of [
    { ...productionEnvironment(), LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE: undefined },
    {
      ...productionEnvironment(),
      LTM_MEDIA_SAFETY_SCANNER_URL: "http://media-safety.example.com",
      LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE: "/var/run/secrets/ltm-broker-credentials/media-scanner-token",
    },
    {
      ...productionEnvironment(),
      LTM_MEDIA_SAFETY_SCANNER_URL: "https://media-safety.example.com",
      LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE: "inline-token",
    },
    { ...productionEnvironment(), LTM_MEDIA_SAFETY_RECEIPT_PUBLIC_KEY_FILE: undefined },
  ]) {
    assert.throws(
      () => loadBrokerConfiguration(environment),
      (error: unknown) => error instanceof BrokerError && error.code === "CONFIGURATION_INVALID",
    );
  }
});

test("production configuration fails closed on plaintext Redis, HTTP IdP, inline paths, or malformed digests", () => {
  const cases: Array<(environment: NodeJS.ProcessEnv) => void> = [
    (environment) => { environment.LTM_BROKER_REDIS_URL = "redis://broker:credential@redis.example.com:6379/0"; }, // secret-scan: allow-test-fixture
    (environment) => { environment.LTM_ENTERPRISE_IDP_URL = "http://identity.example.com"; },
    (environment) => { environment.LTM_WECHAT_APP_SECRET_FILE = "inline-secret"; },
    (environment) => { environment.LTM_BROKER_WORKLOAD_TOKEN_SHA256S = "not-a-digest"; },
  ];
  for (const mutate of cases) {
    const environment = productionEnvironment();
    mutate(environment);
    assert.throws(
      () => loadBrokerConfiguration(environment),
      (error: unknown) => error instanceof BrokerError && error.code === "CONFIGURATION_INVALID",
    );
  }
});
