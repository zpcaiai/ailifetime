import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import {
  AwsS3MultipartObjectStore,
  HttpsEnterpriseIdentityProvider,
  OfficialWechatCodeExchange,
  RedisBrokerStore,
} from "./adapters.js";
import { ClientIntegrationBroker } from "./broker.js";
import { loadBrokerConfiguration } from "./config.js";
import { DigestBearerAuthenticator, RotatingSecretFile } from "./contracts.js";
import { FailClosedMediaSafetyScanner, HttpsMediaSafetyScanner, JpegJsNormalizer } from "./media-security.js";
import {
  MediaDownloadAuthorizer,
  loadSignedMediaLifecycleRegistry,
} from "./media-lifecycle.js";
import { handleBrokerRequest } from "./server.js";

let brokerForCleanup: ClientIntegrationBroker | undefined;
let maintenanceTimer: NodeJS.Timeout | undefined;

async function run(): Promise<void> {
  const configuration = loadBrokerConfiguration(process.env);
  safeTlsFile(configuration.tlsCertificateAuthorityFile, 1_048_576);
  const appSecret = new RotatingSecretFile(configuration.wechatAppSecretFile, 16, 512);
  const idpCredential = new RotatingSecretFile(configuration.identityProviderTokenFile, 20, 8_192);
  const redis = await RedisBrokerStore.connect(
    configuration.redisUrl,
    configuration.appEnvironment !== "production",
    configuration.dependencyTimeoutMs,
  );
  const objects = new AwsS3MultipartObjectStore(
    configuration.s3Bucket,
    configuration.s3KmsKeyId,
    configuration.s3Region,
    undefined,
    configuration.dependencyTimeoutMs,
  );
  const safetyScanner = configuration.mediaSafetyScannerUrl === undefined || configuration.mediaSafetyScannerTokenFile === undefined
    ? new FailClosedMediaSafetyScanner()
    : new HttpsMediaSafetyScanner({
        baseUrl: configuration.mediaSafetyScannerUrl,
        tokenFile: new RotatingSecretFile(configuration.mediaSafetyScannerTokenFile, 20, 8_192),
        timeoutMs: configuration.dependencyTimeoutMs,
        ...(configuration.mediaSafetyReceiptPublicKeyFile === undefined || configuration.mediaSafetyExpectedProvider === undefined ||
            configuration.mediaSafetyExpectedPolicyId === undefined || configuration.mediaSafetyPolicySha256 === undefined ||
            configuration.mediaSafetyExpectedModelVersion === undefined || configuration.mediaSafetyExpectedKeyId === undefined ||
            configuration.mediaSafetyExpectedEnvironment === undefined
          ? {}
          : {
              receiptAuthority: {
                publicKeyFile: configuration.mediaSafetyReceiptPublicKeyFile,
                provider: configuration.mediaSafetyExpectedProvider,
                policyId: configuration.mediaSafetyExpectedPolicyId,
                policySha256: configuration.mediaSafetyPolicySha256,
                modelVersion: configuration.mediaSafetyExpectedModelVersion,
                keyId: configuration.mediaSafetyExpectedKeyId,
                environment: configuration.mediaSafetyExpectedEnvironment,
              },
            }),
      });
  const lifecycleRegistry = configuration.mediaLifecycleCatalogFile === undefined ||
      configuration.mediaLifecycleTrustPublicKeyFile === undefined || configuration.mediaLifecycleExpectedKeyId === undefined ||
      configuration.mediaLifecycleExpectedIssuer === undefined || configuration.mediaLifecycleExpectedEnvironment === undefined
    ? undefined
    : loadSignedMediaLifecycleRegistry({
        catalogFile: configuration.mediaLifecycleCatalogFile,
        trustPublicKeyFile: configuration.mediaLifecycleTrustPublicKeyFile,
        expectedKeyId: configuration.mediaLifecycleExpectedKeyId,
        expectedIssuer: configuration.mediaLifecycleExpectedIssuer,
        expectedEnvironment: configuration.mediaLifecycleExpectedEnvironment,
        ...(configuration.mediaLifecycleTargetSecretRoot === undefined
          ? {}
          : { targetSecretRoot: configuration.mediaLifecycleTargetSecretRoot }),
        timeoutMs: configuration.dependencyTimeoutMs,
      });
  const downloadAuthorizer = configuration.mediaDownloadPrivateKeyFile === undefined ||
      configuration.mediaDownloadPublicKeyFile === undefined || configuration.mediaDownloadBaseUrl === undefined ||
      configuration.mediaDownloadIssuer === undefined
    ? undefined
    : new MediaDownloadAuthorizer({
        privateKeyFile: configuration.mediaDownloadPrivateKeyFile,
        publicKeyFile: configuration.mediaDownloadPublicKeyFile,
        baseUrl: configuration.mediaDownloadBaseUrl,
        issuer: configuration.mediaDownloadIssuer,
        maximumTtlSeconds: configuration.mediaDownloadMaximumTtlSeconds,
      });
  const broker = new ClientIntegrationBroker({
    wechat: new OfficialWechatCodeExchange(
      configuration.wechatAppId,
      appSecret,
      fetch,
      configuration.dependencyTimeoutMs,
    ),
    identity: new HttpsEnterpriseIdentityProvider(
      configuration.identityProviderUrl,
      idpCredential,
      fetch,
      configuration.dependencyTimeoutMs,
    ),
    idempotency: redis,
    uploads: redis,
    assets: redis,
    objects,
    jpegNormalizer: new JpegJsNormalizer(),
    safetyScanner,
    ...(lifecycleRegistry === undefined ? {} : { lifecycleRegistry }),
    ...(downloadAuthorizer === undefined ? {} : { downloadAuthorizer }),
    objectKeyPrefix: configuration.objectKeyPrefix,
  });
  brokerForCleanup = broker;
  let maintenanceRunning = false;
  const runMaintenance = async (): Promise<void> => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      for (const tenantId of configuration.mediaLifecycleMaintenanceTenantIds) {
        let cursor: string | undefined;
        do {
          const result = await broker.runMediaLifecycleMaintenance({
            actorId: "media-lifecycle-maintainer",
            tenantId,
            roles: ["service_account"],
            purpose: "product_operation",
          }, { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
          cursor = result.cursor;
        } while (cursor !== undefined);
      }
    } catch {
      process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "media_lifecycle.maintenance_failed" })}\n`);
    } finally { maintenanceRunning = false; }
  };
  if (configuration.mediaLifecycleMaintenanceTenantIds.length > 0) {
    maintenanceTimer = setInterval(() => void runMaintenance(), configuration.mediaLifecycleMaintenanceIntervalMs);
    maintenanceTimer.unref();
    void runMaintenance();
  }
  const server = createServer({
    cert: safeTlsFile(configuration.tlsCertificateFile, 1_048_576),
    key: safeTlsFile(configuration.tlsPrivateKeyFile, 1_048_576),
    minVersion: "TLSv1.2",
    honorCipherOrder: true,
    requestCert: false,
  }, (request, response) => void handleBrokerRequest({
    broker,
    workloadAuthenticator: new DigestBearerAuthenticator(configuration.workloadTokenSha256s),
  }, request, response));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(configuration.port, configuration.host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    event: "client_integration_broker.started",
    environment: configuration.appEnvironment,
    address: `${configuration.host}:${configuration.port}`,
  })}\n`);
  const shutdown = (): void => {
    server.closeAllConnections();
    server.close(() => undefined);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolvePromise) => server.once("close", resolvePromise));
  await broker.close();
  if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
  maintenanceTimer = undefined;
  brokerForCleanup = undefined;
}

function safeTlsFile(path: string, maximum: number): Buffer {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 32 || metadata.size > maximum || (metadata.mode & 0o022) !== 0) {
    throw new Error("TLS projection is unavailable or unsafe");
  }
  return readFileSync(path);
}

void run().catch(async (error: unknown) => {
  if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
  await brokerForCleanup?.close().catch(() => undefined);
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event: "client_integration_broker.start_failed",
    error: error instanceof Error ? error.name : "UnknownError",
  })}\n`);
  process.exitCode = 1;
});
