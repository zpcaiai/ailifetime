import assert from "node:assert/strict";
import test from "node:test";
import { renderDeveloperPortal } from "./portal.js";

const model = {
  documentationVersion: "1.0.0", contractSha256: "a".repeat(64), productionCredentialEligible: false,
  applications: [{ id: "app-1", partnerId: "partner-1", name: "Synthetic <App>", environment: "sandbox" as const, status: "ACTIVE", requestCount: 12, errorCount: 1 }],
  webhookDeliveries: [{ id: "delivery-1", eventId: "event-1", status: "SUCCEEDED", latencyMs: 20 }],
  connectors: [{ id: "crm", version: "1.0.0", status: "ACTIVE", dataAccess: "consented contacts" }],
  certifications: [{ id: "cert-1", applicationId: "app-1", state: "ACTIVE", expiresAt: "2026-09-28T04:00:00.000Z" }],
  status: [{ component: "api", state: "OPERATIONAL" }, { component: "webhook", state: "OUTAGE", incidentId: "incident-1" }],
};

test("B103/B106/B107/B109/B110 portal renders dedicated accessible surfaces and fail-closed production issuance", () => {
  const html = renderDeveloperPortal(model, { partnerId: "partner-1", actorId: "developer-1", roles: ["developer"] });
  assert.match(html, /<main id="main">/);
  assert.match(html, /Webhook delivery console/);
  assert.match(html, /Versions, connectors and certification/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /Synthetic &lt;App&gt;/);
  assert.doesNotMatch(html, /Synthetic <App>/);
  for (const anchor of ["authentication", "api", "webhooks", "sdks", "errors", "rate-limits", "versions", "examples", "security-consent"]) assert.match(html, new RegExp(`id="${anchor}"`));
});

test("portal rejects cross-partner projections before rendering", () => {
  assert.throws(() => renderDeveloperPortal({ ...model, applications: [{ ...model.applications[0]!, partnerId: "partner-2" }] }, { partnerId: "partner-1", actorId: "developer-1", roles: ["developer"] }), /cross-partner/);
});
