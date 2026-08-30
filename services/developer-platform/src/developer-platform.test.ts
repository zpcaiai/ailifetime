import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import {
  ApiLifecycleService, CERTIFICATION_SCENARIOS, ConnectorPlatform, DeveloperDocumentationBuilder, DeveloperIdentityService,
  DeveloperSandbox, PartnerCertificationService, PORTAL_SECTIONS,
  INTEGRATION_EXAMPLES, REFERENCE_ADAPTERS, SdkContractCompiler, WebhookDeliveryService,
  type ApiContract, type ConnectorManifest, type CredentialConstraints, type CredentialUse,
  type DeveloperDocumentationContract, type FineGrainedScope,
} from "./index.js";

const NOW = new Date("2026-08-28T04:00:00.000Z");
const now = () => new Date(NOW);

function docs(version = "1.0.0"): DeveloperDocumentationContract {
  return {
    version, openApiSha256: "a".repeat(64), eventContractSha256: "b".repeat(64), permissionContractSha256: "c".repeat(64),
    sections: Object.fromEntries(PORTAL_SECTIONS.map((section) => [section, `Versioned developer guidance for ${section} with consent and security boundaries.`])) as unknown as DeveloperDocumentationContract["sections"],
    examples: [{ language: "typescript", title: "Create a sandbox resource", source: "client.create({ idempotencyKey: 'synthetic-key' })", links: ["#authentication", "#security-consent"] }],
    errorCodes: ["AUTHORIZATION_DENIED", "IDEMPOTENCY_CONFLICT"], rateLimits: { sandbox: 100, production: 500 }, sdkVersions: { typescript: "1.0.0", python: "1.0.0", java: "1.0.0" },
  };
}

test("B103 documentation is generated from bound contracts and rejects broken links, secrets and unversioned breaking changes", () => {
  const builder = new DeveloperDocumentationBuilder();
  const built = builder.build(docs(), NOW.toISOString());
  assert.equal(built.contractSha256.length, 64);
  assert.throws(() => builder.build({ ...docs(), examples: [{ language: "curl", title: "unsafe", source: "Authorization: Bearer prod_secret_123456789", links: ["#api"] }] }, NOW.toISOString()), /credential-like/);
  assert.throws(() => builder.build({ ...docs(), examples: [{ language: "curl", title: "broken", source: "idempotency-key: one", links: ["#missing"] }] }, NOW.toISOString()), /broken/);
  assert.throws(() => builder.assertCompatible(docs("1.0.0"), { ...docs("1.1.0"), openApiSha256: "d".repeat(64) }), /new major/);
});

const admin = { partnerId: "partner-1", actorId: "admin-1", roles: ["partner_admin"] as const, agreementsAccepted: true, securityBoundaryAccepted: true };

test("B103 sandbox creates only synthetic resettable data, simulates disorder and isolates partner logs", () => {
  const sandbox = new DeveloperSandbox(now);
  const app = sandbox.createApplication({ idempotencyKey: "create-app-1", applicationId: "app-1", name: "Synthetic Partner App", scenario: "out_of_order" }, admin);
  assert.equal(app.generation, 1);
  assert.equal(sandbox.fixture("app-1", admin).personId.startsWith("syn_person_"), true);
  assert.deepEqual(sandbox.simulate("app-1", admin).map((event) => event.sequence), [2, 1]);
  sandbox.recordRequest({ applicationId: "app-1", request: { authorization: "private", value: "ok" }, response: { payment_token: "private", result: "synthetic" }, status: 200 }, admin);
  assert.deepEqual(sandbox.logs("app-1", admin)[0]?.request, { authorization: "[REDACTED]", value: "ok" });
  assert.throws(() => sandbox.logs("app-1", { ...admin, partnerId: "partner-2" }), /cross-partner/);
  assert.equal(sandbox.reset("app-1", admin).generation, 2);
  assert.equal(sandbox.logs("app-1", admin).length, 0);
});

const scope: FineGrainedScope = { resource: "orders", action: "write", tenantId: "tenant-partner-1", storeIds: ["store-1"], purpose: "fulfillment", dataCategories: ["order"] };
const constraints: CredentialConstraints = { ipCidrs: ["203.0.113.0/24"], allowedDomains: ["partner.example.com"], ratePerMinute: 10, budgetMinorPerDay: 1000 };
const use = (nonce: string): CredentialUse => ({ environment: "sandbox", resource: "orders", action: "write", tenantId: "tenant-partner-1", storeId: "store-1", purpose: "fulfillment", dataCategory: "order", sourceIp: "203.0.113.42", originDomain: "partner.example.com", requestBody: Buffer.from("{}"), nonce, costMinor: 10 });

test("B104 credentials are one-time secrets with scrypt auth, exact scopes, replay/rate/budget controls, rotation and revocation", () => {
  const identity = new DeveloperIdentityService(now);
  const issued = identity.create({ id: "key-1", partnerId: "partner-1", applicationId: "app-1", environment: "sandbox", kind: "api_key", scopes: [scope], constraints, expiresAt: "2026-09-28T04:00:00.000Z" });
  assert.equal(issued.shownOnce, true);
  assert.equal(Object.hasOwn(identity.summary("key-1"), "secret"), false);
  assert.equal(identity.authenticateSecret(issued.secret, use("nonce-1")).partnerId, "partner-1");
  assert.throws(() => identity.authenticateSecret(issued.secret, use("nonce-1")), /replay/);
  assert.throws(() => identity.authenticateSecret(issued.secret, { ...use("nonce-2"), tenantId: "tenant-other" }), /scope denied/);
  const rotated = identity.create({ id: "key-2", partnerId: "partner-1", applicationId: "app-1", environment: "sandbox", kind: "api_key", scopes: [scope], constraints, expiresAt: "2026-09-28T04:00:00.000Z", rotationOf: "key-1" });
  assert.throws(() => identity.authenticateSecret(issued.secret, use("nonce-3")), /revoked/);
  assert.equal(identity.authenticateSecret(rotated.secret, use("nonce-4")).credentialId, "key-2");
  assert.deepEqual(identity.scanLeak(`log accidentally included ltm_sandbox_key-2_prefix`), ["key-2"]);
  assert.equal(identity.summary("key-2").revokedAt, NOW.toISOString());
});

test("B104 production credentials require two-person approval and OAuth tokens are scoped and short lived", () => {
  const identity = new DeveloperIdentityService(now);
  assert.throws(() => identity.create({ id: "prod-1", partnerId: "partner-1", applicationId: "app-1", environment: "production", kind: "service_account", scopes: [scope], constraints, expiresAt: "2026-09-28T04:00:00.000Z" }), /two-person/);
  const client = identity.create({ id: "oauth-1", partnerId: "partner-1", applicationId: "app-1", environment: "sandbox", kind: "oauth_client", scopes: [scope], constraints, expiresAt: "2026-09-28T04:00:00.000Z" });
  const token = identity.issueAccessToken({ clientSecret: client.secret, requestedScopes: [scope], ttlSeconds: 300 });
  assert.equal(identity.authenticateToken(token.secret, use("token-nonce-1")).applicationId, "app-1");
  assert.throws(() => identity.issueAccessToken({ clientSecret: client.secret, requestedScopes: [{ ...scope, action: "admin" }], ttlSeconds: 300 }), /exceeds/);
});

test("B104 optional Ed25519 request signing and mTLS constraints are verified cryptographically", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity = new DeveloperIdentityService(now); const body = Buffer.from("signed-request"); const cert = "e".repeat(64);
  const key = identity.create({ id: "signed-1", partnerId: "partner-1", applicationId: "app-1", environment: "sandbox", kind: "api_key", scopes: [scope], constraints: { ...constraints, signingPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), mtlsCertificateSha256: cert }, expiresAt: "2026-09-28T04:00:00.000Z" });
  assert.equal(identity.authenticateSecret(key.secret, { ...use("signed-nonce"), requestBody: body, requestSignature: sign(null, body, privateKey), mtlsCertificateSha256: cert }).credentialId, "signed-1");
  assert.throws(() => identity.authenticateSecret(key.secret, { ...use("bad-signature"), requestBody: body, requestSignature: Buffer.alloc(64), mtlsCertificateSha256: cert }), /signature/);
});

test("B105 SDK compiler reproducibly generates types, clients, errors, pagination and signed semantic releases", () => {
  const compiler = new SdkContractCompiler();
  const contract = {
    sourceVersion: "1.0.0", openApiSha256: "a".repeat(64), eventSchemaSha256: "b".repeat(64), errors: ["AUTHORIZATION_DENIED", "CONFLICT"],
    models: { Order: [{ name: "id", type: "string" as const, required: true }, { name: "amount_minor", type: "integer" as const, required: true }] },
    operations: [{ id: "orders.list", method: "GET" as const, path: "/v1/orders", idempotent: true, paginated: true }, { id: "orders.create", method: "POST" as const, path: "/v1/orders", idempotent: true, paginated: false }],
  };
  const bundle = compiler.generate(contract);
  compiler.verifyReproducible(contract, bundle);
  assert.match(bundle.files.typescript["client.ts"] ?? "", /AbortSignal/);
  assert.match(bundle.files.python["client.py"] ?? "", /require_idempotency_for_writes/);
  assert.match(bundle.files.java["Client.java"] ?? "", /REQUIRE_REQUEST_ID/);
  assert.deepEqual(INTEGRATION_EXAMPLES.map((example) => example.id), ["resumable-upload", "generate", "query", "share", "order", "webhook-verification", "partner-session"]);
  assert.throws(() => compiler.assertCompatible(contract, { ...contract, sourceVersion: "1.1.0", operations: contract.operations.slice(0, 1) }), /new major/);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = { version: "1.0.0", sourceVersion: "1.0.0", generatedSha256: bundle.generatedSha256, compatibleApiMajors: [1] };
  const manifest = { ...unsigned, signature: sign(null, Buffer.from(JSON.stringify(unsigned), "utf8"), privateKey).toString("base64") };
  compiler.verifyRelease(manifest, publicKey.export({ type: "spki", format: "pem" }).toString());
  assert.throws(() => compiler.verifyRelease({ ...manifest, generatedSha256: "c".repeat(64) }, publicKey.export({ type: "spki", format: "pem" }).toString()), /signature/);
});

test("B106 webhooks verify domains, minimize payloads, sign, retry, preserve event ids on replay and dead-letter fail closed", async () => {
  const requests: Array<{ body: string; headers: Readonly<Record<string, string>> }> = [];
  const statuses = [500, 204, 400];
  const service = new WebhookDeliveryService(randomBytes(32), { send: async (request) => { requests.push({ body: Buffer.from(request.body).toString("utf8"), headers: request.headers }); return { status: statuses.shift() ?? 204, body: Buffer.from("provider response"), latencyMs: 20 }; } }, now);
  assert.throws(() => service.register({ id: "private", partnerId: "partner-1", applicationId: "app-1", environment: "sandbox", url: "https://127.0.0.1/hook", eventTypes: ["order.completed"], payloadVersion: 1, ratePerMinute: 10, concurrencyLimit: 2, allowedFields: ["order_id"] }), /private/);
  const secret = service.register({ id: "endpoint-1", partnerId: "partner-1", applicationId: "app-1", environment: "sandbox", url: "https://partner.example.com/hooks/ltm", eventTypes: ["order.completed"], payloadVersion: 1, ratePerMinute: 10, concurrencyLimit: 2, allowedFields: ["order_id"] });
  assert.throws(() => service.verifyChallenge("endpoint-1", "wrong"), /challenge/);
  service.verifyChallenge("endpoint-1", secret.challenge);
  const event = { eventId: "event-1", type: "order.completed", version: 1, occurredAt: NOW.toISOString(), tenantId: "tenant-partner-1", purpose: "fulfillment", payload: { order_id: "order-1", internal_note: "must not leave" } };
  const attempts = await service.deliver("endpoint-1", event);
  assert.deepEqual(attempts.map((attempt) => attempt.state), ["RETRYABLE", "SUCCEEDED"]);
  assert.equal(JSON.parse(requests[0]?.body ?? "{}").data.internal_note, undefined);
  assert.equal(requests[0]?.headers["x-ltm-event-id"], "event-1");
  assert.equal((await service.deliver("endpoint-1", event)).length, 0);
  assert.equal((await service.deliver("endpoint-1", event, { replayBy: "developer-1" }))[0]?.state, "DEAD_LETTERED");
  assert.equal(service.endpoint("endpoint-1").paused, true);
});

test("B106 production webhook delivery requires DNS egress proof and rejects rebinding", async () => {
  assert.throws(() => new WebhookDeliveryService(randomBytes(32), { send: async () => ({ status: 204, body: Buffer.alloc(0), latencyMs: 1 }) }, now, { environment: "production" }), /DNS resolver/);
  const service = new WebhookDeliveryService(randomBytes(32), { send: async () => ({ status: 204, body: Buffer.alloc(0), latencyMs: 1 }) }, now, { environment: "production", resolveHost: async () => ["10.0.0.4"] });
  const secret = service.register({ id: "endpoint-dns", partnerId: "partner-1", applicationId: "app-1", environment: "production", url: "https://partner.example.com/hooks/ltm", eventTypes: ["order.completed"], payloadVersion: 1, ratePerMinute: 10, concurrencyLimit: 2, allowedFields: ["order_id"] });
  service.verifyChallenge("endpoint-dns", secret.challenge);
  await assert.rejects(() => service.deliver("endpoint-dns", { eventId: "event-dns", type: "order.completed", version: 1, occurredAt: NOW.toISOString(), tenantId: "tenant-1", purpose: "fulfillment", payload: { order_id: "order-1" } }), /private/);
});

function manifest(): ConnectorManifest {
  return { id: "reference-business", publisher: "ltm", version: "1.0.0", categories: ["crm", "cdp_marketing", "support", "accounting"], capabilities: ["contacts", "events", "tickets", "journals"], permissions: ["contacts.write", "tickets.write", "journals.write"], dataCategories: ["contact", "consent", "ticket", "accounting"], eventTypes: ["contact.changed", "ticket.changed", "journal.posted"], configurationSchemaSha256: "a".repeat(64), regions: ["CN", "EU"], ratePerMinute: 100, supportTier: "enterprise", pricing: "contract", artifactSha256: "b".repeat(64) };
}

test("B107-B108 connector manifest/review/install/runtime implement cursor, consent, deletion, controls and emergency revoke", async () => {
  const applied: unknown[] = [];
  const platform = new ConnectorPlatform({ apply: async (input) => { applied.push(input); return { accepted: true, retryable: false, correlationId: `correlation-${input.sourceId}`, amountMinor: input.sourceId === "journal-1" ? 500 : 0 }; } }, now);
  const value = manifest();
  platform.publish(value, { manifestId: value.id, version: value.version, supplyChainScanPassed: true, codeReviewPassed: true, configurationReviewPassed: true, sandboxCertificationId: "cert-1", compatibilityPassed: true, reviewerIds: ["reviewer-1", "reviewer-2"], reviewedAt: NOW.toISOString() });
  assert.deepEqual(Object.keys(REFERENCE_ADAPTERS).sort(), ["accounting", "cdp_marketing", "crm", "support"]);
  platform.install({ id: "install-1", connectorId: value.id, version: value.version, tenantId: "tenant-partner-1", administratorId: "admin-1", credentialReference: "vault:connectors/reference-business", grantedScopes: ["contacts.write", "journals.write"], fieldMappings: [{ sourceField: "email", targetField: "email", sourceOfTruth: "ltm", classification: "confidential", purpose: "contact_sync", contactConsentRequired: true, exportAllowed: true, conflictRule: "manual_case" }, { sourceField: "amount_minor", targetField: "amount_minor", sourceOfTruth: "ltm", classification: "confidential", purpose: "accounting", contactConsentRequired: false, exportAllowed: true, conflictRule: "source_wins" }], privacyFlowConfirmed: true, connectionTestArtifactSha256: "c".repeat(64), quotaPerDay: 100 });
  const report = await platform.sync({ syncId: "sync-1", installId: "install-1", records: [{ sourceId: "contact-1", sequence: 1, updatedAt: NOW.toISOString(), deleted: true, unsubscribed: true, contactConsent: false, values: { email: "private@example.com", amount_minor: 0 } }, { sourceId: "journal-1", sequence: 2, updatedAt: NOW.toISOString(), deleted: false, unsubscribed: false, contactConsent: true, values: { amount_minor: 500 } }], expectedAmountMinor: 500 });
  assert.equal(report.cursor, 2); assert.equal(report.deletionsPropagated, 1); assert.equal(report.unsubscriptionsPropagated, 1);
  assert.equal((applied[0] as { values: Record<string, unknown> }).values.email, undefined);
  assert.equal((applied[0] as { values: Record<string, unknown> }).values.deleted, true);
  assert.equal(platform.emergencyRevoke(value.id, value.version), 1);
  await assert.rejects(() => platform.sync({ syncId: "sync-2", installId: "install-1", records: [], expectedAmountMinor: 0 }), /not active/);
});

test("B107 connector publication rejects unreviewed supply chain and restricted exports", () => {
  const platform = new ConnectorPlatform({ apply: async () => ({ accepted: true, retryable: false, correlationId: "one" }) }, now); const value = manifest();
  assert.throws(() => platform.publish(value, { manifestId: value.id, version: value.version, supplyChainScanPassed: false, codeReviewPassed: true, configurationReviewPassed: true, sandboxCertificationId: "cert-1", compatibilityPassed: true, reviewerIds: ["one", "two"], reviewedAt: NOW.toISOString() }), /incomplete/);
});

test("B109 partner harness runs all adversarial scenarios, redacts secrets, issues bound certification and invalidates changes", async () => {
  const certification = new PartnerCertificationService({ execute: async ({ scenario }) => ({ request: { authorization: "secret", scenario }, response: { ok: true }, events: [{ scenario }], signatures: [`signature-${scenario}`], retries: scenario === "timeout" ? 2 : 0, assertions: [{ id: `${scenario}-assertion`, passed: true, severity: "critical", guidance: "maintain the verified behavior" }] }) }, now);
  const run = await certification.run({ runId: "run-1", applicationId: "app-1", environment: "sandbox", apiVersion: "1.0.0", sdkVersion: "1.0.0", capabilities: ["orders"], configurationSha256: "d".repeat(64) });
  assert.deepEqual(run.results.map((result) => result.scenario), [...CERTIFICATION_SCENARIOS]);
  assert.equal((run.results[0]?.request as { authorization: string }).authorization, "[REDACTED]");
  const issued = certification.issue({ certificationId: "cert-1", runId: "run-1", expiresAt: "2026-09-28T04:00:00.000Z" });
  assert.equal(certification.validate("cert-1", { applicationId: "app-1", environment: "sandbox", apiVersion: "1.0.0", sdkVersion: "1.0.0", capabilities: ["orders"], configurationSha256: "d".repeat(64) }).state, "ACTIVE");
  assert.equal(certification.invalidateForChange("app-1", "connector configuration changed"), 1);
  assert.throws(() => certification.validate(issued.certificationId, { applicationId: "app-1", environment: "sandbox", apiVersion: "1.0.0", sdkVersion: "1.0.0", capabilities: ["orders"], configurationSha256: "d".repeat(64) }), /inactive/);
});

function api(version: string): ApiContract {
  return { version, paths: { "/v1/orders": ["GET", "POST"] }, schemas: { Order: { id: { type: "string", required: true }, note: { type: "string", required: false } } }, events: { "order.completed": ["id", "occurred_at"] }, sdkVersions: { typescript: version, python: version, java: version } };
}

test("B110 lifecycle detects breakage, governs deprecation/usage/changelog and publishes incident-linked status plus SLA", () => {
  const lifecycle = new ApiLifecycleService({ minimumDeprecationDays: 90, securityEmergencyMinimumDays: 7, supportedMajorVersions: 2, supportMatrix: { "1": ["typescript", "python", "java"] } }, now);
  lifecycle.registerContract(api("1.0.0"));
  assert.equal(lifecycle.registerContract({ ...api("1.1.0"), paths: { ...api("1.1.0").paths, "/v1/shares": ["GET"] } })?.additiveChanges.length, 1);
  assert.throws(() => lifecycle.registerContract({ ...api("1.2.0"), paths: {} }), /incomplete|breaking/);
  lifecycle.registerContract({ ...api("2.0.0"), schemas: { Order: { id: { type: "string", required: true } } } });
  lifecycle.publishChange({ id: "release-2", apiVersions: ["2.0.0"], eventVersions: ["order.completed@1"], sdkVersions: { typescript: "2.0.0", python: "2.0.0", java: "2.0.0" }, databaseChanges: ["none"], migrationIds: ["api-major-2"], risks: ["partner migration"], releaseAt: NOW.toISOString(), actions: ["upgrade SDK"] });
  lifecycle.recordUsage({ partnerId: "partner-1", applicationId: "app-1", apiVersion: "1.0.0", sdkVersion: "1.0.0", requestCount: 100, errorCount: 2, observedAt: NOW.toISOString() });
  lifecycle.planDeprecation({ version: "1.0.0", announcedAt: NOW.toISOString(), retiresAt: "2026-12-01T04:00:00.000Z", emergencySecurityException: false, replacementVersion: "2.0.0", migrationGuideSha256: "e".repeat(64), sandboxAvailable: true, harnessAvailable: true, rollbackPlanSha256: "f".repeat(64), parallelRunSupported: true, criticalPartnerIds: ["partner-1"], acknowledgements: ["partner-1"] });
  assert.equal(lifecycle.upgradeWork("partner-1")[0]?.action, "SUPPORT_TASK");
  assert.equal(lifecycle.usageForPartner("partner-2").length, 0);
  lifecycle.defineSla({ tier: "enterprise", severity: "sev1", responseMinutes: 15, updateMinutes: 30, component: "api" });
  for (const component of ["api", "webhook", "sandbox", "documentation", "sdk"] as const) lifecycle.updateStatus({ component, status: component === "webhook" ? "OUTAGE" : "OPERATIONAL", observedAt: NOW.toISOString(), ...(component === "webhook" ? { incidentId: "incident-1" } : {}), uptimeBasisPoints: component === "webhook" ? 9900 : 9999 });
  assert.equal(lifecycle.statusPage().components.length, 5);
});
