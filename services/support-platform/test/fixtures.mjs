import { MemorySupportStateStore, sha256 } from "../src/index.mjs";

export const AT = "2026-08-28T12:00:00.000Z";
export const NOW = new Date(AT);
export const SECRET = "support-platform-test-signing-key-material-32-bytes";
export const D = Object.freeze({ a: sha256("a"), b: sha256("b"), c: sha256("c"), d: sha256("d") });
export function store() { return new MemorySupportStateStore(); }
export function auth(role, purpose, overrides = {}) { return { actorId: `${role}-actor`, tenantId: "tenant-1", roles: [role], purpose, stepUp: false, training: [], ...overrides }; }
export function article(overrides = {}) {
  return {
    articleId: "generation-help", tenantId: "tenant-1", version: "v1", category: "generation", locale: "en-US", roles: ["account-owner", "support-agent"], productVersions: ["web-v1"], region: "us", title: "Generation error help", body: "Check the job status and retry once.", keywords: ["generation", "error"], synonyms: ["render", "failed"], errorCodes: ["GENERATION_TIMEOUT"], statusChecks: ["Check generation state"], recoverySteps: ["Retry once", "Contact support if the failure persists"], escalationRoute: "support-technical", state: "published", approvals: [{ role: "content", actorId: "content-reviewer", evidenceSha256: D.a, approvedAt: AT }], sourceDependencies: [{ sourceId: "generation-api", versionSha256: D.b }], publishedAt: AT, reviewAt: "2026-09-28T12:00:00.000Z", expiresAt: "2027-08-28T12:00:00.000Z", ...overrides,
  };
}
export function ticket(overrides = {}) {
  return { ticketId: "ticket-1", tenantId: "tenant-1", source: "web-form", externalThreadId: "thread-1", requesterReference: "customer-vault:customer-1", requesterVerification: "pending", product: "web", locale: "en-US", severity: "high", tags: ["technical"], summary: "Generation failed for customer@example.com", initialMessage: "Please help +1 202 555 0123", containsOriginalPhoto: false, createdAt: AT, ...overrides };
}
export function sla(overrides = {}) {
  return { policyId: "sla-high-technical", tenantId: "tenant-1", severity: "high", tags: ["technical"], firstResponseMinutes: 30, resolutionMinutes: 240, queueId: "technical-l2", escalationQueueId: "incident-lead", requiredSkills: ["generation"], version: "v1", expiresAt: "2027-08-28T12:00:00.000Z", ...overrides };
}
export function organization(overrides = {}) {
  return { organizationId: "org-1", tenantId: "tenant-1", legalName: "Example Partner", domainSha256: D.a, industry: "retail", region: "us", ownerId: "sales-operator-actor", channel: "direct", source: "business-inquiry", consentBasis: "business-inquiry", createdAt: AT, ...overrides };
}
