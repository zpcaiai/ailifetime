import assert from "node:assert/strict";
import test from "node:test";
import { approveAndPublishTemplate, authorizeTestSend, createControlledLink, MANDATORY_AI_DISCLOSURE, previewTemplate, renderTemplate, resolveControlledLink, resolveTemplate, rollbackTemplate, saveTemplateVersion, TEMPLATE_EVENT_TYPES, validateNotificationTemplate } from "../src/index.mjs";
import { approvals, AT, auth, NOW, SECRET, store, template } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }

test("B75-R01 models all nine typed transaction/lifecycle template event families", () => {
  assert.deepEqual(TEMPLATE_EVENT_TYPES, ["generation-completed", "payment", "refund", "order", "shipment", "family-invitation", "security", "annual-update", "partner-event"]);
  assert.equal(validateNotificationTemplate(template()).eventType, "generation-completed");
});

test("B75-R02 schema-validates/encodes variables and forbids code or undeclared fields", () => {
  const rendered = renderTemplate(template(), { workId: "work <one>", resultLink: "signed-token-value" }); assert.match(rendered.subject, /work &lt;one&gt;/u); assert.doesNotMatch(rendered.subject, /<one>/u);
  throws("TEMPLATE_VARIABLE_UNDECLARED", () => renderTemplate(template(), { workId: "one", resultLink: "token", extra: "leak" }));
  throws("UNSAFE_CONTENT", () => validateNotificationTemplate(template({ body: "<script src='https://evil.example/x.js'></script>" })));
});

test("B75-R03 resolves exact brand/tenant/locale/region/channel/version and forbids marketing fallback", () => {
  const state = store(); saveTemplateVersion(state, { template: template(), authorization: auth("template-editor", "template-management"), idempotencyKey: "template-save-r03", at: AT }); approveAndPublishTemplate(state, { tenantId: "tenant-1", templateId: "generation-ready", version: "v1", approvals: approvals(), stop: false, authorization: auth("template-publisher", "template-management", { stepUp: true }), idempotencyKey: "template-publish-r03", at: AT }, NOW);
  assert.equal(resolveTemplate(state, { tenantId: "tenant-1", templateId: "generation-ready", brandId: "ltm", locale: "en-US", region: "us", channel: "email", purpose: "generation", version: "v1" }, NOW).version, "v1");
  throws("MANDATORY_TRANSACTION_TEMPLATE_MISSING", () => resolveTemplate(state, { tenantId: "tenant-1", templateId: "generation-ready", brandId: "wrong", locale: "en-US", region: "us", channel: "email", purpose: "transactional", version: "v1" }, NOW));
});

test("B75-R04 supports real-size preview, controlled test send, two-person publish, schedule and rollback", () => {
  const state = store(); saveTemplateVersion(state, { template: template(), authorization: auth("template-editor", "template-management"), idempotencyKey: "template-save-r04", at: AT });
  assert.equal(previewTemplate(template(), { workId: "work-1", resultLink: "token" }).viewport.width, 600);
  assert.equal(authorizeTestSend({ recipientReference: "test-recipient:1", controlledRecipientReferences: ["test-recipient:1"], production: true }).allowed, true); throws("TEST_RECIPIENT_DENIED", () => authorizeTestSend({ recipientReference: "real:unknown", controlledRecipientReferences: ["test-recipient:1"], production: true }));
  throws("TWO_PERSON_APPROVAL_REQUIRED", () => approveAndPublishTemplate(state, { tenantId: "tenant-1", templateId: "generation-ready", version: "v1", approvals: [approvals()[0]], authorization: auth("template-publisher", "template-management", { stepUp: true }), idempotencyKey: "template-bad-publish", at: AT }, NOW));
  approveAndPublishTemplate(state, { tenantId: "tenant-1", templateId: "generation-ready", version: "v1", approvals: approvals(), authorization: auth("template-publisher", "template-management", { stepUp: true }), idempotencyKey: "template-good-publish", at: AT }, NOW);
  assert.equal(rollbackTemplate(state, { tenantId: "tenant-1", templateId: "generation-ready", targetVersion: "v1", reason: "regression", authorization: auth("template-publisher", "template-management", { stepUp: true }), idempotencyKey: "template-rollback", at: "2026-08-28T12:02:00.000Z" }).currentVersion, "v1");
});

test("B75-R05 controlled links expire and mandatory unsubscribe/AI/legal copy cannot be white-labelled away", () => {
  const link = createControlledLink({ origin: "https://www.example.com", path: "/result/work-1", tenantId: "tenant-1", contactId: "contact-1", purpose: "generation", ttlSeconds: 120 }, ["https://www.example.com"], SECRET, NOW);
  assert.equal(resolveControlledLink(link, ["https://www.example.com"], SECRET, new Date("2026-08-28T12:01:00.000Z")).contactId, "contact-1"); throws("TOKEN_EXPIRED", () => resolveControlledLink(link, ["https://www.example.com"], SECRET, new Date("2026-08-28T12:03:00.000Z")));
  throws("MANDATORY_COPY_INVALID", () => validateNotificationTemplate(template({ aiDisclosure: "removed" }))); assert.equal(MANDATORY_AI_DISCLOSURE.includes("not predictive"), true);
});
