import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

function stagingEnvironment(): NodeJS.ProcessEnv {
  return {
    ...productionEnvironment(),
    APP_ENV: "staging",
    LTM_MEDIA_S3_BUCKET: "ltm-staging-media",
    LTM_MEDIA_SAFETY_EXPECTED_ENVIRONMENT: "staging",
    LTM_MEDIA_SAFETY_EXPECTED_PROVIDER: "staging-media-scanner",
    LTM_MEDIA_LIFECYCLE_EXPECTED_KEY_ID: "media-policy-staging-1",
    LTM_MEDIA_LIFECYCLE_EXPECTED_ENVIRONMENT: "staging",
    LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS: "tenant-staging-1",
  };
}

test("staging requires scoped media trust, authenticated TLS Redis, and explicit lifecycle maintenance", () => {
  const staging = loadBrokerConfiguration(stagingEnvironment());
  assert.equal(staging.appEnvironment, "staging");
  assert.equal(staging.mediaSafetyExpectedEnvironment, "staging");
  assert.equal(staging.mediaLifecycleExpectedEnvironment, "staging");
  assert.equal(staging.mediaLifecycleTargetSecretRoot, "/var/run/secrets/ltm-media-lifecycle-targets");
  assert.deepEqual(staging.mediaLifecycleMaintenanceTenantIds, ["tenant-staging-1"]);

  const overrides: NodeJS.ProcessEnv[] = [
    { LTM_BROKER_REDIS_URL: "redis://broker:fixture@127.0.0.1:6380/0" }, // secret-scan: allow-test-fixture
    { LTM_BROKER_REDIS_URL: "rediss://redis.example.com:6380/0" },
    { LTM_MEDIA_SAFETY_EXPECTED_ENVIRONMENT: "production" },
    { LTM_MEDIA_LIFECYCLE_EXPECTED_ENVIRONMENT: "production" },
    { LTM_MEDIA_LIFECYCLE_TARGET_SECRET_ROOT: undefined },
    { LTM_MEDIA_LIFECYCLE_MAINTENANCE_TENANT_IDS: undefined },
  ];
  const full = stagingEnvironment();
  for (const prefix of ["LTM_MEDIA_SAFETY_", "LTM_MEDIA_LIFECYCLE_", "LTM_MEDIA_DOWNLOAD_"]) {
    const absent = Object.fromEntries(Object.keys(full).filter(key => key.startsWith(prefix)).map(key => [key, undefined]));
    overrides.push(absent);
  }
  for (const override of overrides) {
    assert.throws(() => loadBrokerConfiguration({ ...full, ...override }), {
      name: "BrokerError", code: "CONFIGURATION_INVALID",
    }, Object.keys(override).join(","));
  }
  const unsignedScanner = Object.fromEntries(
    Object.keys(full)
      .filter(key => key.startsWith("LTM_MEDIA_SAFETY_") && !key.endsWith("_URL") && !key.endsWith("_TOKEN_FILE"))
      .map(key => [key, undefined]),
  );
  assert.throws(() => loadBrokerConfiguration({ ...full, ...unsignedScanner }), /signed staging media safety/);
  const development = loadBrokerConfiguration({
    ...full, ...unsignedScanner, APP_ENV: "development",
    LTM_BROKER_REDIS_URL: "redis://broker:fixture@127.0.0.1:6380/0", // secret-scan: allow-test-fixture
  });
  assert.equal(development.mediaSafetyReceiptPublicKeyFile, undefined);
});

test("the staging process rejects cross-environment media trust before accessing mounted files or listening", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], {
    env: { ...stagingEnvironment(), LTM_MEDIA_LIFECYCLE_EXPECTED_ENVIRONMENT: "production" },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(
    { ...JSON.parse(result.stderr), timestamp: "[time]" },
    { timestamp: "[time]", level: "error", event: "client_integration_broker.start_failed", error: "BrokerError" },
  );
});

test("invalid projected lifecycle policy stops staging startup before dialing Redis", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-broker-startup-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const publicKeyFile = join(directory, "trust.pem");
  const privateKeyFile = join(directory, "signing.pem");
  const catalogFile = join(directory, "catalog.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o400 });
  writeFileSync(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o400 });
  writeFileSync(catalogFile, '{"schemaVersion":"ltm.media-lifecycle-policy-catalog.v1"}', { mode: 0o400 });
  let connections = 0;
  const listener = createServer(socket => {
    connections++;
    socket.destroy();
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  context.after(() => new Promise<void>(resolve => listener.close(() => resolve())));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...stagingEnvironment(),
    LTM_BROKER_TLS_CERT_FILE: publicKeyFile,
    LTM_BROKER_TLS_CA_FILE: publicKeyFile,
    LTM_BROKER_TLS_KEY_FILE: privateKeyFile,
    LTM_MEDIA_SAFETY_RECEIPT_PUBLIC_KEY_FILE: publicKeyFile,
    LTM_MEDIA_LIFECYCLE_CATALOG_FILE: catalogFile,
    LTM_MEDIA_LIFECYCLE_TRUST_PUBLIC_KEY_FILE: publicKeyFile,
    LTM_BROKER_REDIS_URL: `rediss://:fixture@127.0.0.1:${address.port}/0`, // secret-scan: allow-test-fixture
  };
  const exec = promisify(execFile);
  await assert.rejects(
    exec(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], { env, timeout: 5_000 }),
    (error: { code?: unknown; stdout?: unknown; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(JSON.parse(error.stderr ?? "").event, "client_integration_broker.start_failed");
      return true;
    },
  );
  assert.equal(connections, 0);
});
