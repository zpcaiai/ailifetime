import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  acknowledgeStatusNotification,
  confirmStatusSubscription,
  createGovernedShareAsset,
  createStatusSubscription,
  mandatoryTrustStatements,
  markStaleSalesAssets,
  MemoryShareRateLimiter,
  planStatusNotifications,
  publicStatusProjection,
  publicTrustCenter,
  publishBrandAsset,
  publishSalesAsset,
  publishStatusIncident,
  publishStatusMaintenance,
  publishTrustCenter,
  reconcileMaterialDependencies,
  registerMaterialDependencies,
  resolveShareAccess,
  revokeShare,
  validateOfficialMediaKit,
  validateSharePolicy,
  validateUgcTemplate,
} from "../src/index.mjs";
import { approvals, AT, componentMeasurements, D, factCatalog, freshStore, NOW, SECRET, shareAuthorizationAuthority, sharePolicy, shareRequest } from "./fixtures.mjs";

function throwsCode(code, operation) { assert.throws(operation, (error) => error?.code === code); }
async function rejectsCode(code, operation) { await assert.rejects(operation, (error) => error?.code === code); }

async function createShare(store, overrides = {}, authority = shareAuthorizationAuthority()) {
  return createGovernedShareAsset(store, {
    request: shareRequest(overrides), accessId: "shareaccess0123456789abcdef", actorId: "share-worker", idempotencyKey: "share-create-1", at: AT,
  }, sharePolicy(), SECRET, NOW, authority);
}

test("B61-R01 creates AI-labelled brand share cards and actual QR assets", async () => {
  const { root, store } = freshStore();
  try {
    const share = await createShare(store, { caption: null });
    assert.equal(share.caption, null);
    assert.equal(share.brandId, "ltm");
    assert.match(share.aiLabel, /Illustrative, not predictive/u);
    assert.match(share.qrSvg, /^<svg/u);
    assert.equal(share.previewArtifact.variant, "derived-preview");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B61-R02 blocks public minor sharing and original high-resolution media", async () => {
  const { root, store } = freshStore();
  try {
    await rejectsCode("MINOR_SHARING_FORBIDDEN", () => createShare(store, { participantAuthorizationIds: ["share-authorization-minor-public-1"] }));
    await rejectsCode("HIGH_RESOLUTION_MEDIA_FORBIDDEN", () => createShare(store, { previewArtifact: { artifactId: "original-1", sha256: D.d, variant: "original" } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B61-R02 rejects caller-declared participant facts and requires the trusted authorization repository", async () => {
  const { root, store } = freshStore();
  try {
    await rejectsCode("SHARE_AUTHORITY_REQUIRED", () => createGovernedShareAsset(store, { request: shareRequest(), actorId: "share-worker", idempotencyKey: "missing-authority", at: AT }, sharePolicy(), SECRET, NOW));
    await rejectsCode("SHARE_AUTHORIZATION_INVALID", () => createShare(store, {}, shareAuthorizationAuthority({ "share-authorization-adult-1": { authorizationId: "share-authorization-adult-1", participantId: "participant-1", workId: "other-work", purpose: "social-sharing", consentState: "granted", containsMinor: false, guardianState: "not-required", visibility: "unlisted", region: "us", expiresAt: "2026-08-29T12:00:00.000Z", revokedAt: null } })));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B61-R04 access is token-bound, rate-limited, crawler-safe, and revocable", async () => {
  const { root, store } = freshStore();
  try {
    const share = await createShare(store);
    const limiter = new MemoryShareRateLimiter(1, 60_000);
    const crawler = await resolveShareAccess(store, { token: share.token, clientKey: "crawler-1", crawler: true, environment: "test" }, SECRET, limiter, NOW);
    assert.equal(crawler.previewArtifact, null);
    assert.match(crawler.headers["x-robots-tag"], /noindex/u);
    await rejectsCode("RATE_LIMITED", () => resolveShareAccess(store, { token: share.token, clientKey: "crawler-1", crawler: false, environment: "test" }, SECRET, limiter, NOW));
    const revocation = revokeShare(store, { shareId: share.shareId, reason: "participant withdrawal", actorId: "privacy-operator", idempotencyKey: "share-revoke-1", at: "2026-08-28T12:01:00.000Z" }, sharePolicy());
    assert.equal(revocation.purgeTasks.length, 2);
    await rejectsCode("SHARE_GONE", () => resolveShareAccess(store, { token: share.token, clientKey: "visitor-2", crawler: false, environment: "test" }, SECRET, new MemoryShareRateLimiter(), NOW));
    await rejectsCode("DURABLE_RATE_LIMITER_REQUIRED", () => resolveShareAccess(store, { token: share.token, clientKey: "visitor-3", crawler: false, environment: "production" }, SECRET, new MemoryShareRateLimiter(), NOW));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B61-R05 media kit accepts only synthetic examples with brand/legal approval", () => {
  const kit = validateOfficialMediaKit({ kitId: "kit-1", version: "v1", brandGuideVersion: "brand-v1", sampleDataOrigin: "synthetic", assets: ["asset-1"], licenses: ["license-1"], approvedBy: ["brand", "legal"] });
  assert.match(kit.verificationSha256, /^[a-f0-9]{64}$/u);
  throwsCode("REAL_CUSTOMER_MEDIA_FORBIDDEN", () => validateOfficialMediaKit({ kitId: "kit-1", version: "v1", brandGuideVersion: "brand-v1", sampleDataOrigin: "customer", assets: ["asset-1"], licenses: ["license-1"], approvedBy: ["brand", "legal"] }));
});

test("B61-R03 share policy only permits licensed, regional, moderated, bounded UGC", () => {
  assert.equal(validateSharePolicy(sharePolicy()).shareOrigin, "https://www.example.com");
  throwsCode("VALIDATION_FAILED", () => validateSharePolicy({ ...sharePolicy(), shareOrigin: "http://example.com" }));
  const template = shareRequest().template;
  assert.equal(validateUgcTemplate(template, "us", NOW).licenses[0].commercialUse, true);
  throwsCode("ASSET_LICENSE_INVALID", () => validateUgcTemplate({ ...template, licenses: [{ ...template.licenses[0], commercialUse: false }] }, "us", NOW));
});

test("B62-R01 publishes versioned licensed brand assets using synthetic demos", () => {
  const { root, store } = freshStore();
  try {
    const result = publishBrandAsset(store, { actorId: "brand-operator", idempotencyKey: "brand-v1", at: AT, asset: {
      assetId: "demo-asset-1", type: "demo-asset", version: "v1", artifactSha256: D.a, sourceOrigin: "synthetic",
      license: { licenseId: "brand-license-1", scope: "public-web", territories: ["us"], expiresAt: "2027-08-28T00:00:00.000Z", evidenceSha256: D.b },
      approvals: approvals(["brand", "legal"]), publishedAt: AT, expiresAt: "2027-08-28T00:00:00.000Z",
    } }, NOW);
    assert.equal(result.version, "v1");
    assert.equal(store.read().records.trust.brandAssets["demo-asset-1"].currentVersion, "v1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B62-R02 trust center enforces non-weakenable AI, child, and high-impact boundaries", () => {
  const { root, store } = freshStore();
  try {
    const trustCenter = {
      version: "trust-v1", dataFlows: ["Uploads are processed into derived artistic assets."], retentionDeletion: ["Source media follows the published retention schedule."],
      subprocessors: ["synthetic-provider"], ...mandatoryTrustStatements, securityControls: ["Encryption and purpose-bound access controls."],
      certifications: [{ certificationId: "cert-1", label: "Verified control", status: "verified", provider: "independent-auditor", evidenceSha256: D.c, verifiedAt: AT, expiresAt: "2027-08-28T00:00:00.000Z" }],
      approvals: approvals(["privacy", "security", "legal"]), publishedAt: AT,
    };
    publishTrustCenter(store, { trustCenter, actorId: "trust-operator", idempotencyKey: "trust-v1", at: AT }, NOW);
    const projection = publicTrustCenter(store, NOW);
    assert.equal(Object.hasOwn(projection, "approvals"), false);
    assert.equal(projection.certifications.length, 1);
    throwsCode("TRUST_STATEMENT_INVALID", () => publishTrustCenter(store, { trustCenter: { ...trustCenter, aiDisclosure: "AI prediction" }, actorId: "trust-operator", idempotencyKey: "trust-bad", at: AT }, NOW));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B62-R03 public status exposes controlled components/incidents without topology", () => {
  const { root, store } = freshStore();
  try {
    publishStatusIncident(store, { actorId: "incident-commander", idempotencyKey: "incident-1", at: AT, incident: {
      incidentId: "incident-1", title: "Generation latency", severity: "major", state: "monitoring", components: ["generation"],
      startedAt: "2026-08-28T11:00:00.000Z", resolvedAt: null,
      updates: [{ at: "2026-08-28T11:00:00.000Z", state: "investigating", message: "We are investigating elevated latency." }, { at: AT, state: "monitoring", message: "Mitigation is active and being monitored." }],
    } });
    publishStatusMaintenance(store, { actorId: "incident-commander", idempotencyKey: "maintenance-1", at: AT, maintenance: {
      maintenanceId: "maintenance-1", title: "API database maintenance", state: "scheduled", components: ["api"],
      startsAt: "2026-08-29T01:00:00.000Z", endsAt: "2026-08-29T02:00:00.000Z", message: "The API may be briefly unavailable during this window.",
    } });
    const generation = componentMeasurements().generation;
    const projection = publicStatusProjection(store, componentMeasurements({ generation: { ...generation, state: "degraded", availabilityBasisPoints: 9_500 } }), NOW);
    assert.equal(projection.overall, "degraded");
    assert.equal(projection.incidents.length, 1);
    assert.equal(projection.maintenances.length, 1);
    assert.equal(projection.components.website.history[0].availabilityBasisPoints, 9_995);
    assert.match(projection.privacyBoundary, /No internal topology/u);
    assert.equal(JSON.stringify(projection).includes("customerId"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B62-R03 status subscriptions require signed confirmation and produce receipt-bound deliveries", () => {
  const { root, store } = freshStore();
  try {
    const pending = createStatusSubscription(store, { actorId: "subscriber-agent", idempotencyKey: "subscription-1", at: AT, subscription: { subscriptionId: "subscription-1", channel: "email", destinationReference: "notification-provider:recipient/status-1", destinationSha256: D.e, locale: "en-US", components: ["website", "api"] } }, SECRET, NOW);
    assert.equal(pending.state, "pending-confirmation");
    const active = confirmStatusSubscription(store, { token: pending.confirmationToken, actorId: "subscriber-agent", idempotencyKey: "subscription-confirm-1", at: "2026-08-28T12:01:00.000Z" }, SECRET, new Date("2026-08-28T12:01:00.000Z"));
    assert.equal(active.state, "active");
    publishStatusMaintenance(store, { actorId: "incident-commander", idempotencyKey: "maintenance-subscription-1", at: "2026-08-28T12:02:00.000Z", maintenance: {
      maintenanceId: "maintenance-subscription-1", title: "Website maintenance", state: "scheduled", components: ["website"],
      startsAt: "2026-08-29T01:00:00.000Z", endsAt: "2026-08-29T02:00:00.000Z", message: "The website may be briefly unavailable.",
    } });
    const planned = planStatusNotifications(store, { eventKind: "maintenance", eventId: "maintenance-subscription-1", actorId: "status-worker", idempotencyKey: "notification-plan-1", at: "2026-08-28T12:03:00.000Z" });
    assert.equal(planned.deliveries.length, 1);
    assert.equal(planned.deliveries[0].destinationReference, "notification-provider:recipient/status-1");
    const acknowledged = acknowledgeStatusNotification(store, { deliveryId: planned.deliveries[0].deliveryId, state: "delivered", providerReceiptSha256: D.f, actorId: "notification-adapter", idempotencyKey: "notification-ack-1", at: "2026-08-28T12:04:00.000Z" });
    assert.equal(acknowledged.state, "delivered");
    assert.equal(acknowledged.attempts, 1);
    throwsCode("STATUS_DELIVERY_TERMINAL", () => acknowledgeStatusNotification(store, { deliveryId: planned.deliveries[0].deliveryId, state: "failed", providerReceiptSha256: D.a, actorId: "notification-adapter", idempotencyKey: "notification-ack-2", at: "2026-08-28T12:05:00.000Z" }));
    throwsCode("SUBSCRIPTION_DESTINATION_INVALID", () => createStatusSubscription(store, { actorId: "subscriber-agent", idempotencyKey: "subscription-bad", at: AT, subscription: { subscriptionId: "subscription-bad", channel: "email", destinationReference: "person@example.com", destinationSha256: D.e, locale: "en-US", components: ["website"] } }, SECRET, NOW));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B62-R04 sales artifacts require type-specific approvals and current facts", () => {
  const { root, store } = freshStore();
  try {
    const asset = {
      assetId: "sales-deck-1", type: "sales-deck", version: "v1", artifactSha256: D.c, implementationVersion: "product-v1",
      factBindings: [{ factId: "retention-policy", valueSha256: D.a, sourceArtifactSha256: D.b }],
      approvals: approvals(["content", "sales", "brand", "finance"]), publishedAt: AT, expiresAt: "2027-08-28T00:00:00.000Z",
    };
    assert.equal(publishSalesAsset(store, { asset, actorId: "sales-operator", idempotencyKey: "sales-v1", at: AT }, factCatalog(), NOW).state, "current");
    const changedCatalog = factCatalog({ facts: [{ ...factCatalog().facts[0], valueSha256: D.f }] });
    const reconciliation = markStaleSalesAssets(store, { actorId: "facts-worker", idempotencyKey: "sales-reconcile-1", at: "2026-08-28T12:02:00.000Z" }, changedCatalog, NOW);
    assert.equal(reconciliation.stale.length, 1);
    assert.match(reconciliation.stale[0].reasons[0], /fact-drift/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B62-R05 certification/vendor/policy drift marks every dependent public material stale", () => {
  const { root, store } = freshStore();
  try {
    registerMaterialDependencies(store, { actorId: "dependency-worker", idempotencyKey: "deps-page-1", at: AT, material: {
      materialId: "home-en-US", materialType: "page", materialVersion: "v1",
      dependencies: [{ kind: "policy", dependencyId: "privacy-policy", stateSha256: D.a }, { kind: "vendor", dependencyId: "media-provider", stateSha256: D.b }],
    } });
    const result = reconcileMaterialDependencies(store, { actorId: "dependency-worker", idempotencyKey: "deps-reconcile-1", at: "2026-08-28T12:03:00.000Z", currentDependencies: [
      { kind: "policy", dependencyId: "privacy-policy", stateSha256: D.f, status: "changed" },
      { kind: "vendor", dependencyId: "media-provider", stateSha256: D.b, status: "current" },
    ] });
    assert.equal(result.invalidationRequired, true);
    assert.equal(result.stale[0].materialType, "page");
    assert.match(result.stale[0].reasons[0], /dependency-changed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
