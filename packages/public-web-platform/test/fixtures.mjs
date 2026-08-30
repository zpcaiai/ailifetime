import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, VersionedMarketingStore } from "../src/index.mjs";

export const NOW = new Date("2026-08-28T12:00:00.000Z");
export const AT = NOW.toISOString();
export const SECRET = "public-web-platform-test-key-material-32-bytes-minimum";
export const D = Object.freeze({
  a: sha256("a"), b: sha256("b"), c: sha256("c"), d: sha256("d"), e: sha256("e"), f: sha256("f"),
});

export function freshStore() {
  const root = mkdtempSync(join(tmpdir(), "ltm-public-web-test-"));
  const store = new VersionedMarketingStore(join(root, "state.json"));
  store.initialize();
  return { root, store };
}

export function editorialAuthorization(actorId = "editor-1", roles = ["editor"]) {
  const key = `${actorId}:${roles.join("+")}`;
  const known = { "editor-1:editor": "editor-auth-1", "author-1:author": "author-auth-1" };
  if (known[key] === undefined) throw new Error(`test authorization is not registered: ${key}`);
  return known[key];
}

export const editorialAuthority = Object.freeze({
  resolve(authorizationId) {
    const records = {
      "editor-auth-1": { authorizationId: "editor-auth-1", actorId: "editor-1", roles: ["editor"], purpose: "marketing-content", expiresAt: "2026-09-28T00:00:00.000Z", revokedAt: null },
      "author-auth-1": { authorizationId: "author-auth-1", actorId: "author-1", roles: ["author"], purpose: "marketing-content", expiresAt: "2026-09-28T00:00:00.000Z", revokedAt: null },
    };
    return records[authorizationId];
  },
});

export function loadExampleSite() {
  const path = fileURLToPath(new URL("../config/site.example.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

export function draftContent(overrides = {}) {
  const body = overrides.body ?? "A safe editorial body.";
  return {
    contentId: "article-1",
    type: "article",
    version: "v1",
    title: "Editorial article",
    body,
    sourceLocale: "en-US",
    requiredLocales: ["en-US"],
    translations: [],
    mediaReferences: [{ mediaId: "media-1", sha256: D.a, state: "ready", alt: "Synthetic abstract illustration" }],
    state: "draft",
    approvals: [],
    scheduledAt: null,
    publishedAt: null,
    sourceSha256: sha256(body),
    ...overrides,
  };
}

export function consentPolicy(overrides = {}) {
  return {
    schemaVersion: "ltm.marketing-consent-policy.v1",
    policyId: "marketing-us",
    version: "v1",
    region: "us",
    noticeSha256: D.a,
    allowedTagDomains: ["analytics.example.com"],
    allowedProxyOrigins: ["https://www.example.com"],
    tags: [{
      tagId: "analytics-v1",
      purpose: "analytics",
      domain: "analytics.example.com",
      proxyUrl: "https://www.example.com/marketing-proxy/analytics",
      dataFields: ["event_id", "campaign_id"],
      cspSource: "https://analytics.example.com",
    }],
    downstreamProcessors: ["analytics-processor"],
    attributionWindowDays: 30,
    ...overrides,
  };
}

export function consentInput(overrides = {}) {
  return {
    receiptId: "receipt-1",
    subjectKeySha256: D.b,
    deviceKeySha256: D.c,
    source: "banner",
    choices: { essential: true, preferences: false, analytics: true, advertising: false },
    actorId: "visitor-1",
    idempotencyKey: "consent-1",
    at: AT,
    ...overrides,
  };
}

export function campaignPolicy() {
  return {
    webOrigins: ["https://www.example.com"],
    appLinkOrigins: ["https://app.example.com"],
    partnerOrigins: ["https://partner.example.com"],
    iosScheme: "ltmapp",
    entryOrigin: "https://www.example.com",
  };
}

export function campaign(overrides = {}) {
  return {
    campaignId: "campaign-1",
    version: "v1",
    state: "active",
    creatives: ["creative-1"],
    audienceId: "audience-1",
    channels: ["social"],
    budgetTags: ["budget-us"],
    utm: { source: "social", medium: "paid", campaign: "launch", term: null, content: "creative-1" },
    shortCode: "0123456789abcdefghij",
    qrBinding: { kind: "campaign", id: "campaign-1" },
    startsAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-09-30T00:00:00.000Z",
    destinations: {
      web: "https://www.example.com/en-US/product",
      ios: "ltmapp://campaign/campaign-1",
      android: "https://app.example.com/campaign/campaign-1",
      wechat: "pages/campaign/index",
      partner: "https://partner.example.com/campaign/campaign-1",
    },
    attributionWindowDays: 30,
    approvals: ["marketing", "privacy"],
    terminationReason: null,
    ...overrides,
  };
}

export function sharePolicy() {
  return { shareOrigin: "https://www.example.com", allowedRegions: ["us"], purgeTargets: ["cdn", "social-platform"], maximumTtlSeconds: 86_400 };
}

export function shareRequest(overrides = {}) {
  return {
    shareId: "share-1",
    workId: "work-1",
    brandId: "ltm",
    assetKind: "share-card",
    platform: "web",
    region: "us",
    caption: "An illustrative moment",
    ageRange: "Adult artistic age range",
    participantAuthorizationIds: ["share-authorization-adult-1"],
    template: {
      templateId: "template-1",
      version: "v1",
      campaignId: "campaign-1",
      moderationState: "approved",
      regions: ["us"],
      expiresAt: "2026-09-30T00:00:00.000Z",
      licenses: [{ assetId: "font-1", kind: "font", licenseId: "license-1", commercialUse: true, territories: ["us"], expiresAt: "2026-09-30T00:00:00.000Z" }],
    },
    previewArtifact: { artifactId: "preview-1", sha256: D.d, variant: "derived-preview" },
    expiresAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

export function shareAuthorizationAuthority(overrides = {}) {
  const records = {
    "share-authorization-adult-1": { authorizationId: "share-authorization-adult-1", participantId: "participant-1", workId: "work-1", purpose: "social-sharing", consentState: "granted", containsMinor: false, guardianState: "not-required", visibility: "unlisted", region: "us", expiresAt: "2026-08-29T12:00:00.000Z", revokedAt: null },
    "share-authorization-minor-public-1": { authorizationId: "share-authorization-minor-public-1", participantId: "child-1", workId: "work-1", purpose: "social-sharing", consentState: "granted", containsMinor: true, guardianState: "verified", visibility: "public", region: "us", expiresAt: "2026-08-29T12:00:00.000Z", revokedAt: null },
    ...overrides,
  };
  return Object.freeze({ resolve: (authorizationId) => records[authorizationId] });
}

export function approvals(roles, overrides = {}) {
  return roles.map((role, index) => ({
    role,
    approvalId: `${role}-approval-${index + 1}`,
    evidenceSha256: sha256(`${role}-evidence-${index}`),
    approvedAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2027-08-28T00:00:00.000Z",
    ...overrides,
  }));
}

export function factCatalog(overrides = {}) {
  return {
    implementationVersion: "product-v1",
    generatedAt: AT,
    facts: [{ factId: "retention-policy", valueSha256: D.a, sourceArtifactSha256: D.b, status: "verified", verifiedAt: "2026-08-28T00:00:00.000Z", expiresAt: "2027-08-28T00:00:00.000Z" }],
    ...overrides,
  };
}

export function componentMeasurements(overrides = {}) {
  const value = Object.fromEntries(["website", "api", "generation", "media-processing", "authentication", "notifications"].map((component) => [component, { state: "operational", measuredAt: AT, availabilityBasisPoints: 9_999, history: [{ periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-08-28T00:00:00.000Z", availabilityBasisPoints: 9_995 }] }]));
  return { ...value, ...overrides };
}
