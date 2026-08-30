import assert from "node:assert/strict";
import {
  createCipheriv,
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import test from "node:test";
import { canonicalJson, verifyExternalEvidenceSignature } from "@ltm/core";
import {
  AppleStoreEvidenceIntegration,
  attestOperationalReport,
  AwsSecretsManagerResolver,
  DurableEvidenceAttestor,
  Ed25519EvidenceAttestor,
  GooglePlayEvidenceIntegration,
  GooglePlayRtdnIntegration,
  FetchHttpTransport,
  ProductionIntegrationError,
  RedisReplayStore,
  S3EvidenceArtifactStore,
  SignedPartnerCommandAdapter,
  SignedPartnerWebhookIntegration,
  WechatPayApiClient,
  WechatPayEvidenceIntegration,
  isGlobalUnicastAddress,
  parseCapacityTestReport,
  parseConfigurationChangeReport,
  parseExperienceGateReport,
  parseModelEvaluationReport,
  parseResilienceExerciseReport,
  preflightPartnerCommandAdapterCredentials,
  preflightPartnerSignatureKey,
  requiredString,
  sha256,
  toRuntimeExternalEvidence,
  type CapabilityEvidenceBindingTemplate,
  type EvidenceArtifactStore,
  type EvidenceEnvelopeStore,
  type DnsAddressResolver,
  type HardenedHttpRequest,
  type HttpTransport,
  type ReplayStore,
  type SecretReference,
  type SecretResolver,
  type TrustedCommerceBindingResolver,
} from "./index.js";

const NOW = new Date();

class MemorySecrets implements SecretResolver {
  constructor(private readonly values: ReadonlyMap<SecretReference, Uint8Array>) {}
  async resolve(reference: SecretReference): Promise<Uint8Array> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error("missing synthetic secret");
    return Buffer.from(value);
  }
}

class MemoryArtifacts implements EvidenceArtifactStore {
  readonly stored: string[] = [];
  async put(input: Parameters<EvidenceArtifactStore["put"]>[0]): Promise<{ uri: string; sha256: string }> {
    assert.equal(sha256(input.artifact), input.sha256);
    this.stored.push(input.sha256);
    return { uri: `memory://synthetic/${input.sha256}`, sha256: input.sha256 };
  }
}

class MemoryReplays implements ReplayStore {
  readonly seen = new Set<string>();
  async claimOnce(namespace: string, value: string, _expiresAt: Date): Promise<boolean> {
    const key = `${namespace}:${value}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

class MemoryEvidenceEnvelopes implements EvidenceEnvelopeStore {
  readonly values = new Map<string, Buffer>();
  attempts = 0;

  async getOrStore(scope: string, candidate: Uint8Array, _expiresAt: Date): Promise<Uint8Array> {
    this.attempts += 1;
    const existing = this.values.get(scope);
    if (existing !== undefined) return Buffer.from(existing);
    const stored = Buffer.from(candidate);
    this.values.set(scope, stored);
    return Buffer.from(stored);
  }
}

function testAttestor(extraSecrets: ReadonlyMap<SecretReference, Uint8Array> = new Map()) {
  const pair = generateKeyPairSync("ed25519");
  const privateReference: SecretReference = "vault:test-attestor";
  const values = new Map(extraSecrets);
  values.set(privateReference, Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })));
  const secrets = new MemorySecrets(values);
  const attestor = new Ed25519EvidenceAttestor({
    issuer: "test:ltm-native-integration",
    keyId: "test-native-key",
    privateKeyReference: privateReference,
    clock: () => NOW,
  }, secrets);
  return { attestor, secrets, publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) };
}

test("durable attestor reuses the first signed envelope across callback retries", async () => {
  const { attestor } = testAttestor();
  const envelopes = new MemoryEvidenceEnvelopes();
  const durable = new DurableEvidenceAttestor(attestor, envelopes);
  const artifact = Buffer.from("exact synthetic store callback bytes");
  const binding = {
    tenantId: "tenant-1",
    batchId: "B66",
    operation: "verifyStoreTransaction",
    kind: "store-transaction",
    provider: "google-play",
    artifactSha256: sha256(artifact),
    environment: "sandbox",
    subjectId: "gplay:durable-transaction-1",
  } as const;

  const first = await durable.attest(binding, artifact);
  const retried = await durable.attest(binding, artifact);

  assert.deepEqual(retried, first);
  assert.equal(envelopes.attempts, 2);
  assert.equal(envelopes.values.size, 1);
  assert.equal(retried.evidenceId, first.evidenceId);
  assert.equal(retried.nonce, first.nonce);
  assert.equal(retried.signature, first.signature);
});

test("outbound transport rejects non-global DNS answers before opening TLS", async () => {
  const rejectedAddresses = [
    "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.0.1", "198.18.0.1", "203.0.113.1", "::1", "fc00::1", "fe80::1", "2001:db8::1",
  ];
  for (const address of rejectedAddresses) assert.equal(isGlobalUnicastAddress(address), false, address);
  assert.equal(isGlobalUnicastAddress("8.8.8.8"), true);
  assert.equal(isGlobalUnicastAddress("2606:4700:4700::1111"), true);

  const privateDns: DnsAddressResolver = {
    async resolve() { return [{ address: "169.254.169.254", family: 4 }]; },
  };
  await assert.rejects(new FetchHttpTransport(privateDns).request({
    url: new URL("https://provider.example.test/v1/callback"),
    method: "POST",
    body: Buffer.from("{}"),
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_REJECTED");

  const mixedDns: DnsAddressResolver = {
    async resolve() {
      return [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.2", family: 4 },
      ];
    },
  };
  await assert.rejects(new FetchHttpTransport(mixedDns).request({
    url: new URL("https://provider.example.test/v1/callback"),
    method: "POST",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_REJECTED");
});

test("operational report attestation accepts only closed server-verified PASS schemas", async () => {
  const scenarios = ["baseline", "peak", "burst", "soak", "dependency_degraded"];
  const fixtures: readonly {
    readonly parse: (bytes: Uint8Array) => unknown;
    readonly report: Record<string, unknown>;
    readonly forgedField: string;
    readonly forgedValue: unknown;
  }[] = [
    {
      parse: parseExperienceGateReport,
      report: {
        version: "ltm.experience-gate-report.v1", releaseCandidate: "release-56", baselineId: "baseline-56",
        taskSuccessRate: 0.95, unresolvedCriticalIssues: 0, controlledCopyApproved: true,
        aiDisclosurePresent: true, humanVisualApproval: true, violations: [], passed: true,
      },
      forgedField: "unresolvedCriticalIssues",
      forgedValue: 1,
    },
    {
      parse: parseModelEvaluationReport,
      report: {
        version: "ltm.model-evaluation-report.v1", evaluationId: "evaluation-118", modelVersion: "model-v1",
        promptVersion: "prompt-v1", datasetId: "dataset-1", cohorts: ["adult", "minor", "zh", "en"],
        metrics: ["safety", "fairness", "quality", "latency", "cost", "stability"], criticalFailures: 0,
        rollbackReady: true, rawMediaRetained: false, violations: [], passed: true,
      },
      forgedField: "rollbackReady",
      forgedValue: false,
    },
    {
      parse: parseConfigurationChangeReport,
      report: {
        version: "ltm.configuration-change-report.v1", changeId: "change-119", targetEnvironment: "production",
        schemaVersion: "schema-v1", changedFields: ["featureFlags"], driftFindingsCount: 0,
        disabledNonWaivableControls: [], rollbackVerified: true, violations: [], passed: true,
      },
      forgedField: "driftFindingsCount",
      forgedValue: 1,
    },
    {
      parse: parseCapacityTestReport,
      report: {
        version: "ltm.capacity-test-report.v1", testRunId: "capacity-121", scenarios,
        observedP95Ms: 800, maxP95Ms: 1_000, observedErrorRate: 0.001, maxErrorRate: 0.01,
        syntheticDataOnly: true, paidTasksProtected: true, tenantFairnessVerified: true, violations: [], passed: true,
      },
      forgedField: "observedP95Ms",
      forgedValue: 2_000,
    },
    {
      parse: parseResilienceExerciseReport,
      report: {
        version: "ltm.resilience-exercise-report.v1", exerciseId: "exercise-122", targetRtoSeconds: 300,
        observedRtoSeconds: 200, targetRpoSeconds: 60, observedRpoSeconds: 30, failoverRegion: "cn-north-1",
        cancellationPriorityVerified: true, deletionResurrectionPrevented: true,
        duplicateSideEffectsPrevented: true, violations: [], passed: true,
      },
      forgedField: "deletionResurrectionPrevented",
      forgedValue: false,
    },
  ];
  for (const fixture of fixtures) {
    fixture.parse(Buffer.from(JSON.stringify(fixture.report)));
    assert.throws(() => fixture.parse(Buffer.from(JSON.stringify({
      ...fixture.report,
      [fixture.forgedField]: fixture.forgedValue,
    }))), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");
  }

  const { attestor, publicKey } = testAttestor();
  const capacityReport = fixtures[3];
  assert.ok(capacityReport);
  const capacityArtifact = Buffer.from(JSON.stringify(capacityReport.report));
  const evidence = await attestOperationalReport(attestor, {
    tenantId: "tenant-1",
    batchId: "B121",
    operation: "approveCapacityGate",
    kind: "capacity-test-report",
    provider: "load-test:runner-121",
    artifactSha256: sha256(capacityArtifact),
    environment: "sandbox",
    subjectId: "capacity-121",
  }, capacityArtifact);
  assert.equal(evidence.binding.subjectId, "capacity-121");
  assert.equal(verifyExternalEvidenceSignature(toRuntimeExternalEvidence(evidence), publicKey), true);
});

test("Google Play backend response is bound to sandbox evidence without storing the purchase token", async () => {
  const { attestor, publicKey } = testAttestor();
  const artifacts = new MemoryArtifacts();
  const token = "synthetic-google-play-token-123456789";
  let observedRequest: HardenedHttpRequest | undefined;
  const transport: HttpTransport = {
    async request(input) {
      observedRequest = input;
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: Buffer.from(JSON.stringify({
          kind: "androidpublisher#productPurchase",
          purchaseState: 0,
          acknowledgementState: 1,
          productId: "life.yearly",
          purchaseToken: token,
          orderId: "GPA.synthetic-order",
          obfuscatedExternalAccountId: "account-hash-1",
          purchaseType: 1,
        })),
      };
    },
  };
  const integration = new GooglePlayEvidenceIntegration(
    { packageName: "com.example.ailifetime" },
    { getAccessToken: async () => "synthetic-oauth-access-token-value" },
    artifacts,
    attestor,
    transport,
  );
  const result = await integration.verifyAndAttest({
    tenantId: "tenant-1",
    environment: "sandbox",
    purchaseType: "product",
    purchaseToken: token,
    productId: "life.yearly",
    expectedObfuscatedAccountId: "account-hash-1",
    requireActiveEntitlement: true,
  });
  assert.equal(result.receipt.state, "PURCHASED");
  assert.equal(result.evidence.binding.subjectId, `gplay:${sha256(Buffer.from(token))}`);
  assert.equal(result.evidence.binding.subjectId.includes(token), false);
  assert.equal(observedRequest?.url.hostname, "androidpublisher.googleapis.com");
  assert.equal(observedRequest?.headers?.authorization, "Bearer synthetic-oauth-access-token-value");
  assert.equal(verifyExternalEvidenceSignature(toRuntimeExternalEvidence(result.evidence), publicKey), true);
});

test("Google Play RTDN authenticates Pub/Sub, stores exact bytes, resolves ownership, and rejects replay", async () => {
  const { attestor } = testAttestor();
  const artifacts = new MemoryArtifacts();
  const replays = new MemoryReplays();
  const purchaseToken = "synthetic-rtdn-purchase-token-123456789";
  const purchase = new GooglePlayEvidenceIntegration(
    { packageName: "com.example.ailifetime" },
    { getAccessToken: async () => "synthetic-oauth-access-token-value" },
    artifacts,
    attestor,
    {
      async request() {
        return {
          status: 200,
          headers: new Headers(),
          body: Buffer.from(JSON.stringify({
            kind: "androidpublisher#productPurchase",
            purchaseState: 0,
            acknowledgementState: 1,
            productId: "life.yearly",
            purchaseToken,
            obfuscatedExternalAccountId: "account-hash-rtdn",
            purchaseType: 1,
          })),
        };
      },
    },
  );
  const commerce: TrustedCommerceBindingResolver = {
    async resolveApple() { throw new Error("unused"); },
    async resolveGoogle(input) {
      assert.equal(input.purchaseTokenSha256, sha256(Buffer.from(purchaseToken)));
      return { tenantId: "tenant-1", accountId: "account-1", expectedObfuscatedAccountId: "account-hash-rtdn" };
    },
    async resolveGoogleVoided(input) {
      assert.equal(input.purchaseTokenSha256, sha256(Buffer.from(purchaseToken)));
      assert.equal(input.orderId, "GPA.voided-order-1");
      assert.equal(input.providerProductType, 2);
      return {
        tenantId: "tenant-1",
        accountId: "account-1",
        productId: "life.yearly",
        purchaseType: "product",
        expectedObfuscatedAccountId: "account-hash-rtdn",
      };
    },
    async resolveWechat() { throw new Error("unused"); },
  };
  const integration = new GooglePlayRtdnIntegration({
    packageName: "com.example.ailifetime",
    subscription: "projects/ltm-test/subscriptions/google-play-rtdn",
    clock: () => NOW,
  }, {
    async verifyAuthorization(value) {
      if (value !== "Bearer verified-google-oidc-token") {
        throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "invalid synthetic identity");
      }
    },
  }, purchase, replays, artifacts, commerce);
  const developerNotification = Buffer.from(JSON.stringify({
    version: "1.0",
    packageName: "com.example.ailifetime",
    eventTimeMillis: String(NOW.getTime()),
    oneTimeProductNotification: { version: "1.0", notificationType: 1, purchaseToken, sku: "life.yearly" },
  }));
  const rawBody = Buffer.from(JSON.stringify({
    message: {
      messageId: "google-message-1001",
      publishTime: NOW.toISOString(),
      data: developerNotification.toString("base64"),
    },
    subscription: "projects/ltm-test/subscriptions/google-play-rtdn",
  }));
  await assert.rejects(integration.verifyAndAttest({
    tenantId: "tenant-1", environment: "sandbox", authorization: "Bearer forged", rawBody,
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_SIGNATURE_INVALID");
  const result = await integration.verifyAndAttest({
    tenantId: "tenant-1", environment: "sandbox", authorization: "Bearer verified-google-oidc-token", rawBody,
  });
  assert.equal(result.disposition, "attested");
  if (result.disposition === "attested") assert.equal(result.receipt.accountId, "account-1");
  assert.equal(artifacts.stored.includes(sha256(rawBody)), true);
  await assert.rejects(integration.verifyAndAttest({
    tenantId: "tenant-1", environment: "sandbox", authorization: "Bearer verified-google-oidc-token", rawBody,
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_REPLAY_DETECTED");

  const voidedNotification = Buffer.from(JSON.stringify({
    version: "1.0",
    packageName: "com.example.ailifetime",
    eventTimeMillis: String(NOW.getTime() + 1),
    voidedPurchaseNotification: {
      purchaseToken,
      orderId: "GPA.voided-order-1",
      productType: 2,
      refundType: 1,
    },
  }));
  const voidedRawBody = Buffer.from(JSON.stringify({
    message: {
      messageId: "google-message-1002",
      publishTime: NOW.toISOString(),
      data: voidedNotification.toString("base64"),
    },
    subscription: "projects/ltm-test/subscriptions/google-play-rtdn",
  }));
  const voided = await integration.verifyAndAttest({
    tenantId: "tenant-1",
    environment: "sandbox",
    authorization: "Bearer verified-google-oidc-token",
    rawBody: voidedRawBody,
  });
  assert.equal(voided.disposition, "attested");
  if (voided.disposition === "attested") {
    assert.equal(voided.businessEvent.eventType, "entitlement.refunded");
    assert.equal(voided.businessEvent.canonicalClaims.orderId, "GPA.voided-order-1");
  }
});

test("WeChat API v3 callback verifies raw RSA signature, decrypts AES-GCM, binds totals, and rejects replay", async () => {
  const apiKeyReference: SecretReference = "vault:test-wechat-api-v3";
  const apiKey = Buffer.from("12345678901234567890123456789012");
  const { attestor, secrets, publicKey: attestorPublicKey } = testAttestor(new Map([[apiKeyReference, apiKey]]));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const artifacts = new MemoryArtifacts();
  const replays = new MemoryReplays();
  const commerce: TrustedCommerceBindingResolver = {
    async resolveApple() { throw new Error("unused"); },
    async resolveGoogle() { throw new Error("unused"); },
    async resolveGoogleVoided() { throw new Error("unused"); },
    async resolveWechat(input) {
      assert.equal(input.outTradeNo, "order-1001");
      return {
        tenantId: "tenant-1",
        accountId: "account-1",
        paymentId: "payment-1001",
        expectedAmountMinor: 8_800,
        expectedCurrency: "CNY",
      };
    },
  };
  const integration = new WechatPayEvidenceIntegration(
    { merchantId: "1900000109", apiV3KeyReference: apiKeyReference, clock: () => NOW },
    secrets,
    { resolve: async () => rsa.publicKey.export({ type: "spki", format: "pem" }) },
    replays,
    artifacts,
    attestor,
    commerce,
  );
  const resourceNonce = "0123456789ab";
  const associatedData = "transaction";
  const transaction = Buffer.from(JSON.stringify({
    mchid: "1900000109",
    out_trade_no: "order-1001",
    transaction_id: "wx-transaction-1001",
    trade_state: "SUCCESS",
    success_time: "2026-08-20T08:00:00+08:00",
    amount: { total: 8800, currency: "CNY" },
  }));
  const cipher = createCipheriv("aes-256-gcm", apiKey, Buffer.from(resourceNonce));
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(transaction), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const rawBody = Buffer.from(JSON.stringify({
    id: "wechat-event-1001",
    event_type: "TRANSACTION.SUCCESS",
    resource: { algorithm: "AEAD_AES_256_GCM", nonce: resourceNonce, associated_data: associatedData, ciphertext },
  }));
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const nonce = "callback-nonce-1001";
  const signingMessage = Buffer.concat([
    Buffer.from(timestamp), Buffer.from("\n"), Buffer.from(nonce), Buffer.from("\n"), rawBody, Buffer.from("\n"),
  ]);
  const signature = cryptoSign("RSA-SHA256", signingMessage, rsa.privateKey).toString("base64");
  const input = {
    tenantId: "tenant-1",
    environment: "sandbox" as const,
    headers: { timestamp, nonce, serial: "7777777777777777", signature },
    rawBody,
  };
  const result = await integration.verifyAndAttest(input);
  assert.equal(result.receipt.transactionId, "wx-transaction-1001");
  assert.equal(result.receipt.amountMinor, 8800);
  assert.equal(result.receipt.paymentId, "payment-1001");
  assert.equal(result.businessEvent.eventType, "payment.captured");
  assert.equal(verifyExternalEvidenceSignature(toRuntimeExternalEvidence(result.evidence), attestorPublicKey), true);
  await assert.rejects(integration.verifyAndAttest(input), (error: unknown) =>
    error instanceof ProductionIntegrationError && error.code === "PROVIDER_REPLAY_DETECTED");

  const refundResourceNonce = "abcdef012345";
  const refundAssociatedData = "refund";
  const refundPayload = Buffer.from(JSON.stringify({
    mchid: "1900000109",
    out_trade_no: "order-1001",
    transaction_id: "wx-transaction-1001",
    refund_id: "wx-refund-1001",
    refund_status: "SUCCESS",
    success_time: "2026-08-20T08:00:01+08:00",
    amount: { total: 8800, refund: 8800, currency: "CNY" },
  }));
  const refundCipher = createCipheriv("aes-256-gcm", apiKey, Buffer.from(refundResourceNonce));
  refundCipher.setAAD(Buffer.from(refundAssociatedData));
  const refundCiphertext = Buffer.concat([
    refundCipher.update(refundPayload),
    refundCipher.final(),
    refundCipher.getAuthTag(),
  ]).toString("base64");
  const refundRawBody = Buffer.from(JSON.stringify({
    id: "wechat-event-1002",
    event_type: "REFUND.SUCCESS",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      nonce: refundResourceNonce,
      associated_data: refundAssociatedData,
      ciphertext: refundCiphertext,
    },
  }));
  const refundNonce = "callback-nonce-1002";
  const refundSigningMessage = Buffer.concat([
    Buffer.from(timestamp), Buffer.from("\n"), Buffer.from(refundNonce), Buffer.from("\n"),
    refundRawBody, Buffer.from("\n"),
  ]);
  const refundSignature = cryptoSign("RSA-SHA256", refundSigningMessage, rsa.privateKey).toString("base64");
  const refund = await integration.verifyAndAttest({
    tenantId: "tenant-1",
    environment: "sandbox",
    headers: { timestamp, nonce: refundNonce, serial: "7777777777777777", signature: refundSignature },
    rawBody: refundRawBody,
  });
  assert.equal(refund.businessEvent.eventType, "payment.refunded");
  assert.equal(refund.businessEvent.canonicalClaims.refundId, "wx-refund-1001");
  assert.equal(refund.businessEvent.sequence, Date.parse("2026-08-20T08:00:01+08:00"));
});

test("WeChat Native order signs the exact request and verifies the signed API response", async () => {
  const merchantKeyReference: SecretReference = "vault:test-wechat-merchant-key";
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secrets = new MemorySecrets(new Map([[
    merchantKeyReference,
    Buffer.from(merchant.privateKey.export({ type: "pkcs8", format: "pem" })),
  ]]));
  const clock = () => NOW;
  let staleResponse = false;
  const transport: HttpTransport = {
    async request(input) {
      assert.equal(input.url.toString(), "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
      const authorization = input.headers?.authorization ?? "";
      const match = /nonce_str="([a-f0-9]+)",timestamp="(\d+)",serial_no="merchant-serial-1",signature="([A-Za-z0-9+/=]+)"$/.exec(authorization);
      assert.ok(match);
      const nonce = match[1];
      const timestamp = match[2];
      const encodedSignature = match[3];
      assert.ok(nonce && timestamp && encodedSignature);
      const signingMessage = Buffer.concat([
        Buffer.from(`POST\n/v3/pay/transactions/native\n${timestamp}\n${nonce}\n`),
        Buffer.from(input.body ?? []),
        Buffer.from("\n"),
      ]);
      assert.equal(cryptoVerify("RSA-SHA256", signingMessage, merchant.publicKey, Buffer.from(encodedSignature, "base64")), true);
      const body = Buffer.from(JSON.stringify({ code_url: "weixin://wxpay/synthetic-code" }));
      const responseTimestamp = String(Math.floor(NOW.getTime() / 1_000) - (staleResponse ? 1_000 : 0));
      const responseNonce = "response-nonce-1";
      const responseMessage = Buffer.concat([
        Buffer.from(responseTimestamp), Buffer.from("\n"), Buffer.from(responseNonce), Buffer.from("\n"), body, Buffer.from("\n"),
      ]);
      const responseSignature = cryptoSign("RSA-SHA256", responseMessage, platform.privateKey).toString("base64");
      return {
        status: 200,
        headers: new Headers({
          "wechatpay-timestamp": responseTimestamp,
          "wechatpay-nonce": responseNonce,
          "wechatpay-serial": "platform-serial-1",
          "wechatpay-signature": responseSignature,
        }),
        body,
      };
    },
  };
  const client = new WechatPayApiClient({
    merchantId: "1900000109",
    appId: "wx1234567890abcdef",
    merchantCertificateSerial: "merchant-serial-1",
    merchantPrivateKeyReference: merchantKeyReference,
    notifyUrl: new URL("https://api.example.test/v1/integrations/wechat-pay/callback"),
    clock,
  }, secrets, {
    resolve: async (serial) => {
      assert.equal(serial, "platform-serial-1");
      return platform.publicKey.export({ type: "spki", format: "pem" });
    },
  }, transport);
  const order = await client.createNativeOrder({
    outTradeNo: "order_1001",
    description: "AI Life Time Machine yearly plan",
    amountMinor: 8800,
    currency: "CNY",
  });
  assert.equal(order.codeUrl, "weixin://wxpay/synthetic-code");
  assert.match(order.providerResponseSha256, /^[a-f0-9]{64}$/);
  staleResponse = true;
  await assert.rejects(client.createNativeOrder({
    outTradeNo: "order_1002",
    description: "AI Life Time Machine yearly plan",
    amountMinor: 8800,
    currency: "CNY",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_SIGNATURE_INVALID");
});

test("signed partner webhook performs domain validation and cannot be replayed", async () => {
  const webhookReference: SecretReference = "vault:test-partner-webhook";
  const webhookKey = Buffer.from("partner-webhook-secret-at-least-32-bytes");
  const { attestor, secrets } = testAttestor(new Map([[webhookReference, webhookKey]]));
  const artifacts = new MemoryArtifacts();
  const replays = new MemoryReplays();
  type TaxTemplate = Extract<CapabilityEvidenceBindingTemplate, { batchId: "B89" }>;
  const integration = new SignedPartnerWebhookIntegration<TaxTemplate>({
    provider: "tax-authority:synthetic",
    signatureScheme: "hmac-sha256",
    verificationKeyReference: webhookReference,
    retentionClass: "financial",
    validate(payload, binding) {
      assert.equal(payload.state, "accepted");
      assert.equal(payload.invoiceRequestId, binding.subjectId);
    },
  }, secrets, replays, artifacts, attestor, () => NOW);
  const rawBody = Buffer.from(canonicalJson({ state: "accepted", invoiceRequestId: "invoice-request-1" }));
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const nonce = "tax-webhook-nonce-1";
  const signedPayload = Buffer.from(`ltm-provider-webhook-v1\n${timestamp}\n${nonce}\n${sha256(rawBody)}\n`);
  const signature = createHmac("sha256", webhookKey).update(signedPayload).digest("base64");
  const input = {
    binding: {
      tenantId: "tenant-1", batchId: "B89", operation: "requestTaxDocument",
      kind: "tax-document-request", provider: "tax-authority:synthetic",
      environment: "sandbox", subjectId: "invoice-request-1",
    } as const,
    rawBody,
    timestamp,
    nonce,
    signature,
  };
  const terminalCallback = {
    eventId: "tax-terminal-event-1",
    terminalState: "succeeded",
    providerOccurredAt: NOW.toISOString(),
    sequence: 1,
    providerOperationId: "tax-provider-operation-1",
  } as const;
  const attested = await integration.verifyAndAttestExternalCommandTerminal(input, () => terminalCallback);
  assert.equal(attested.evidence.artifactSha256, sha256(rawBody));
  assert.equal(attested.event.subjectId, input.binding.subjectId);
  assert.equal(attested.event.correlationId, input.binding.subjectId);
  assert.equal(attested.event.eventType, "external-command.succeeded");
  await assert.rejects(
    integration.verifyAndAttestExternalCommandTerminal(input, () => terminalCallback),
    /already been processed/,
  );
});

test("signed partner webhook accepts only exact canonical JSON bytes after signature verification", async () => {
  const webhookReference: SecretReference = "vault:test-canonical-partner-webhook";
  const webhookKey = Buffer.from("canonical-partner-webhook-secret-at-least-32-bytes");
  const { attestor, secrets } = testAttestor(new Map([[webhookReference, webhookKey]]));
  const artifacts = new MemoryArtifacts();
  const replays = new MemoryReplays();
  let validationCalls = 0;
  type TaxTemplate = Extract<CapabilityEvidenceBindingTemplate, { batchId: "B89" }>;
  const integration = new SignedPartnerWebhookIntegration<TaxTemplate>({
    provider: "tax-authority:canonical",
    signatureScheme: "hmac-sha256",
    verificationKeyReference: webhookReference,
    retentionClass: "financial",
    validate(payload, binding) {
      validationCalls += 1;
      assert.equal(payload.invoiceRequestId, binding.subjectId);
      assert.equal(payload.quantity, 1);
      assert.equal(payload.state, "accepted");
      assert.equal(payload.text, "café");
    },
  }, secrets, replays, artifacts, attestor, () => NOW);
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const binding = {
    tenantId: "tenant-1", batchId: "B89", operation: "requestTaxDocument",
    kind: "tax-document-request", provider: "tax-authority:canonical",
    environment: "sandbox", subjectId: "invoice-canonical-1",
  } as const;
  const signedInput = (rawBody: Buffer, nonce: string) => {
    const signedPayload = Buffer.from(`ltm-provider-webhook-v1\n${timestamp}\n${nonce}\n${sha256(rawBody)}\n`);
    return {
      binding,
      rawBody,
      timestamp,
      nonce,
      signature: createHmac("sha256", webhookKey).update(signedPayload).digest("base64"),
    };
  };
  const canonicalBody = Buffer.from(canonicalJson({
    invoiceRequestId: "invoice-canonical-1",
    quantity: 1,
    state: "accepted",
    text: "café",
  }));
  const nonCanonicalBodies = [
    Buffer.from('{"invoiceRequestId":"invoice-canonical-1","invoiceRequestId":"invoice-canonical-1","quantity":1,"state":"accepted","text":"café"}'),
    Buffer.concat([canonicalBody, Buffer.from("\n")]),
    Buffer.from('{"state":"accepted","text":"café","quantity":1,"invoiceRequestId":"invoice-canonical-1"}'),
    Buffer.from(String.raw`{"invoiceRequestId":"invoice-canonical-1","quantity":1,"state":"accepted","text":"caf\u00e9"}`),
    Buffer.from('{"invoiceRequestId":"invoice-canonical-1","quantity":1.0,"state":"accepted","text":"café"}'),
  ];
  for (const [index, body] of nonCanonicalBodies.entries()) {
    await assert.rejects(
      integration.verifyAndAttest(signedInput(body, `canonical-reject-${index}`)),
      (error: unknown) => error instanceof ProductionIntegrationError &&
        error.code === "PROVIDER_RESPONSE_INVALID" && /canonical JSON/.test(error.message),
    );
  }
  assert.equal(validationCalls, 0);
  assert.equal(artifacts.stored.length, 0);
  assert.equal(replays.seen.size, 0);

  const forged = signedInput(canonicalBody, "canonical-invalid-signature");
  await assert.rejects(
    integration.verifyAndAttest({ ...forged, signature: Buffer.alloc(32).toString("base64") }),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_SIGNATURE_INVALID",
  );
  assert.equal(validationCalls, 0);

  const evidence = await integration.verifyAndAttest(signedInput(canonicalBody, "canonical-accepted"));
  assert.equal(evidence.artifactSha256, sha256(canonicalBody));
  assert.equal(validationCalls, 1);
  assert.deepEqual(artifacts.stored, [sha256(canonicalBody)]);
  assert.equal(replays.seen.size, 1);
});

test("standalone partner verification does not consume replay state before durable processing succeeds", async () => {
  const webhookReference: SecretReference = "vault:test-partner-retry";
  const webhookKey = Buffer.from("partner-retry-secret-at-least-32-bytes");
  const { attestor, secrets } = testAttestor(new Map([[webhookReference, webhookKey]]));
  const replays = new MemoryReplays();
  let storeAttempts = 0;
  const artifacts: EvidenceArtifactStore = {
    async put(input) {
      storeAttempts += 1;
      if (storeAttempts === 1) throw new Error("synthetic transient artifact failure");
      return { uri: `memory://retry/${input.sha256}`, sha256: input.sha256 };
    },
  };
  type TaxTemplate = Extract<CapabilityEvidenceBindingTemplate, { batchId: "B89" }>;
  const integration = new SignedPartnerWebhookIntegration<TaxTemplate>({
    provider: "tax-authority:retry",
    signatureScheme: "hmac-sha256",
    verificationKeyReference: webhookReference,
    retentionClass: "financial",
    validate() {},
  }, secrets, replays, artifacts, attestor, () => NOW);
  const rawBody = Buffer.from(canonicalJson({ state: "accepted", invoiceRequestId: "invoice-retry-1" }));
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const nonce = "tax-webhook-retry-nonce-1";
  const signedPayload = Buffer.from(`ltm-provider-webhook-v1\n${timestamp}\n${nonce}\n${sha256(rawBody)}\n`);
  const input = {
    binding: {
      tenantId: "tenant-1", batchId: "B89", operation: "requestTaxDocument",
      kind: "tax-document-request", provider: "tax-authority:retry",
      environment: "sandbox", subjectId: "invoice-retry-1",
    } as const,
    rawBody,
    timestamp,
    nonce,
    signature: createHmac("sha256", webhookKey).update(signedPayload).digest("base64"),
  };

  await assert.rejects(integration.verifyAndAttest(input), /synthetic transient artifact failure/);
  assert.equal(replays.seen.size, 0);
  const evidence = await integration.verifyAndAttest(input);
  assert.equal(evidence.binding.subjectId, "invoice-retry-1");
  assert.equal(replays.seen.size, 1);
  await assert.rejects(integration.verifyAndAttest(input), (error: unknown) =>
    error instanceof ProductionIntegrationError && error.code === "PROVIDER_REPLAY_DETECTED");
});

test("required provider strings reject leading and trailing whitespace instead of normalizing it", () => {
  assert.equal(requiredString("provider-value", "provider field"), "provider-value");
  for (const value of [" provider-value", "provider-value ", "\tprovider-value", "provider-value\n", "\u00a0provider-value"]) {
    assert.throws(
      () => requiredString(value, "provider field"),
      (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID",
    );
  }
});

test("partner command requires a v2 signed receipt bound to idempotency and the exact request bytes", async () => {
  const reference: SecretReference = "vault:test-command";
  const secret = Buffer.from("partner-command-secret-at-least-32-bytes");
  const secrets = new MemorySecrets(new Map([[reference, secret]]));
  let observed: HardenedHttpRequest | undefined;
  const responseTimestamp = String(Math.floor(NOW.getTime() / 1_000));
  const responseNonce = "partner-receipt-nonce-1";
  const adapter = new SignedPartnerCommandAdapter(
    {
      endpoint: new URL("https://partner.example.test/v1/commands"),
      signingSecretReference: reference,
      responseVerificationKeyReference: reference,
      responseSignatureScheme: "hmac-sha256",
    },
    secrets,
    { request: async (input) => {
      observed = input;
      const requestDigest = input.headers?.["x-ltm-content-sha256"] ?? "";
      const responseBody = Buffer.from(JSON.stringify({
        version: "ltm-provider-receipt.v2",
        accepted: true,
        providerRequestId: "provider-job-1",
        requestContentSha256: requestDigest,
      }));
      const responseDigest = sha256(responseBody);
      const responsePayload = Buffer.from(
        `ltm-provider-receipt-v2\n${responseTimestamp}\n${responseNonce}\njob-1\n${requestDigest}\n${responseDigest}\n`,
      );
      const responseSignature = createHmac("sha256", secret).update(responsePayload).digest("base64");
      return {
        status: 202,
        headers: new Headers({
          "content-type": "application/json",
          "x-ltm-timestamp": responseTimestamp,
          "x-ltm-nonce": responseNonce,
          "x-ltm-idempotency-key": "job-1",
          "x-ltm-request-content-sha256": requestDigest,
          "x-ltm-content-sha256": responseDigest,
          "x-ltm-signature": responseSignature,
        }),
        body: responseBody,
      };
    } },
    () => NOW,
  );
  const result = await adapter.send({
    tenantId: "tenant-1", batchId: "B98", operation: "createVendorProductionJob",
    idempotencyKey: "job-1", payload: { quantity: 1 },
  });
  assert.equal(result.providerRequestId, "provider-job-1");
  assert.match(observed?.headers?.["x-ltm-signature"] ?? "", /^[A-Za-z0-9+/]+=*$/);
  assert.equal(observed?.headers?.["idempotency-key"], "job-1");

  for (const mutation of ["unsigned", "tampered", "request-mismatch", "body-mismatch"] as const) {
    const rejecting = new SignedPartnerCommandAdapter({
      endpoint: new URL("https://partner.example.test/v1/commands"),
      signingSecretReference: reference,
      responseVerificationKeyReference: reference,
      responseSignatureScheme: "hmac-sha256",
    }, secrets, {
      async request(request) {
        const actualRequestDigest = request.headers?.["x-ltm-content-sha256"] ?? "";
        const signedRequestDigest = mutation === "request-mismatch" ? "b".repeat(64) : actualRequestDigest;
        const bodyRequestDigest = mutation === "body-mismatch" ? "c".repeat(64) : actualRequestDigest;
        const signedBody = Buffer.from(JSON.stringify({
          version: "ltm-provider-receipt.v2",
          accepted: true,
          providerRequestId: "provider-job-1",
          requestContentSha256: bodyRequestDigest,
        }));
        const responseDigest = sha256(signedBody);
        const responseSignature = createHmac("sha256", secret).update(Buffer.from(
          `ltm-provider-receipt-v2\n${responseTimestamp}\n${responseNonce}\njob-1\n${signedRequestDigest}\n${responseDigest}\n`,
        )).digest("base64");
        return {
          status: 202,
          headers: mutation === "unsigned" ? new Headers() : new Headers({
            "x-ltm-timestamp": responseTimestamp,
            "x-ltm-nonce": responseNonce,
            "x-ltm-idempotency-key": "job-1",
            "x-ltm-request-content-sha256": signedRequestDigest,
            "x-ltm-content-sha256": responseDigest,
            "x-ltm-signature": responseSignature,
          }),
          body: mutation === "tampered"
            ? Buffer.from(JSON.stringify({ ...JSON.parse(signedBody.toString("utf8")), providerRequestId: "attacker-job" }))
            : signedBody,
        };
      },
    }, () => NOW);
    await assert.rejects(rejecting.send({
      tenantId: "tenant-1", batchId: "B98", operation: "createVendorProductionJob",
      idempotencyKey: "job-1", payload: { quantity: 1 },
    }), (error: unknown) => error instanceof ProductionIntegrationError && (
      error.code === "PROVIDER_SIGNATURE_INVALID" ||
      (mutation === "body-mismatch" && error.code === "PROVIDER_RESPONSE_INVALID")
    ));
  }
});

test("partner command startup preflight resolves all keys and enforces exact ES256 P-256 material", async () => {
  const hmacReference: SecretReference = "vault:test-preflight-hmac";
  const edReference: SecretReference = "vault:test-preflight-ed25519";
  const p256Reference: SecretReference = "vault:test-preflight-p256";
  const p384Reference: SecretReference = "vault:test-preflight-p384";
  const shortReference: SecretReference = "vault:test-preflight-short";
  const ed = generateKeyPairSync("ed25519");
  const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const secrets = new MemorySecrets(new Map([
    [hmacReference, Buffer.from("preflight-hmac-key-at-least-thirty-two-bytes")],
    [edReference, Buffer.from(ed.publicKey.export({ type: "spki", format: "pem" }))],
    [p256Reference, Buffer.from(p256.publicKey.export({ type: "spki", format: "pem" }))],
    [p384Reference, Buffer.from(p384.publicKey.export({ type: "spki", format: "pem" }))],
    [shortReference, Buffer.from("too-short")],
  ]));

  await preflightPartnerCommandAdapterCredentials({
    endpoint: new URL("https://partner.example.test/v1/commands"),
    signingSecretReference: hmacReference,
    responseVerificationKeyReference: edReference,
    responseSignatureScheme: "ed25519",
  }, secrets);
  await preflightPartnerSignatureKey(p256Reference, "es256", secrets);
  await assert.rejects(
    preflightPartnerSignatureKey(p384Reference, "es256", secrets),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "CONFIGURATION_INVALID",
  );
  await assert.rejects(
    preflightPartnerSignatureKey(shortReference, "hmac-sha256", secrets),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "CONFIGURATION_INVALID",
  );
});

test("Apple production verifier refuses incomplete trust configuration before accepting a JWS", async () => {
  const { attestor, secrets } = testAttestor(new Map([["vault:test-apple-root", Buffer.from("synthetic-root")]]));
  const integration = new AppleStoreEvidenceIntegration({
    bundleId: "com.example.ailifetime",
    appleRootCertificateReferences: ["vault:test-apple-root"],
    enableOnlineCertificateChecks: true,
  }, secrets, new MemoryArtifacts(), attestor);
  await assert.rejects(integration.verifyAndAttest({
    tenantId: "tenant-1",
    environment: "production",
    signedTransaction: "a".repeat(100) + ".b.c",
    expectedTransactionId: "transaction-1",
  }), /requires appAppleId/);
});

test("managed infrastructure resolves AWS secrets, confirms S3/KMS Object Lock, and claims Redis replay keys atomically", async () => {
  let secretId;
  const resolver = new AwsSecretsManagerResolver({
    async send(command) {
      secretId = command.input.SecretId;
      return { SecretString: "synthetic-managed-value", $metadata: {} };
    },
  });
  assert.equal(Buffer.from(await resolver.resolve("secret-manager:ltm/test/key")).toString(), "synthetic-managed-value");
  assert.equal(secretId, "ltm/test/key");

  const observedPut: { input?: {
    ServerSideEncryption?: string;
    ObjectLockMode?: string;
    ChecksumAlgorithm?: string;
  } } = {};
  const artifactStore = new S3EvidenceArtifactStore({
    bucket: "ltm-evidence-test",
    keyPrefix: "external-evidence/v1",
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/synthetic",
    retentionDays: { financial: 365, release: 730, operational: 30 },
    clock: () => NOW,
  }, {
    async send(command) {
      observedPut.input = {
        ...(command.input.ServerSideEncryption === undefined ? {} : { ServerSideEncryption: command.input.ServerSideEncryption }),
        ...(command.input.ObjectLockMode === undefined ? {} : { ObjectLockMode: command.input.ObjectLockMode }),
        ...(command.input.ChecksumAlgorithm === undefined ? {} : { ChecksumAlgorithm: command.input.ChecksumAlgorithm }),
      };
      return { ChecksumSHA256: command.input.ChecksumSHA256, $metadata: {} };
    },
  });
  const artifact = Buffer.from("synthetic evidence artifact");
  const artifactDigest = sha256(artifact);
  const stored = await artifactStore.put({
    tenantId: "tenant-1", provider: "tax-authority:synthetic", subjectId: "invoice-1",
    artifact, sha256: artifactDigest, retentionClass: "financial",
  });
  assert.equal(observedPut.input?.ServerSideEncryption, "aws:kms");
  assert.equal(observedPut.input?.ObjectLockMode, "COMPLIANCE");
  assert.equal(observedPut.input?.ChecksumAlgorithm, "SHA256");
  assert.match(stored.uri, /^s3:\/\/ltm-evidence-test\//);

  let claims = 0;
  let replayKey = "";
  const replayStore = new RedisReplayStore({
    isReady: true,
    async set(key, _value, options) {
      replayKey = key;
      assert.equal(options.condition, "NX");
      assert.equal(options.expiration.type, "PX");
      claims += 1;
      return claims === 1 ? "OK" : null;
    },
    async close() {},
  }, { clock: () => NOW });
  const expiresAt = new Date(NOW.getTime() + 60_000);
  assert.equal(await replayStore.claimOnce("wechat-pay", "native-event", expiresAt), true);
  assert.equal(await replayStore.claimOnce("wechat-pay", "native-event", expiresAt), false);
  assert.match(replayKey, /^ltm:replay:v1:[a-f0-9]{64}$/);
});
