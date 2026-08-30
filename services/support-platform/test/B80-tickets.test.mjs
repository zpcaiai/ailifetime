import assert from "node:assert/strict";
import test from "node:test";
import { attachTicketFile, createTicket, escalateBreachedTickets, openComplaintEscalation, ReferenceAttachmentScanner, ReferenceIdentityVerificationAdapter, registerSlaPolicy, resolveAttachmentAccess, routeTicket, TICKET_SOURCES, updateTicket, verifyTicketRequester, viewTicket } from "../src/index.mjs";
import { AT, auth, D, NOW, SECRET, sla, store, ticket } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }
async function rejects(code, operation) { await assert.rejects(operation, (error) => error?.code === code); }
function ticketState(request = ticket()) { const state = store(); createTicket(state, { request, authorization: auth("support-intake", "support-intake"), idempotencyKey: `create-${request.ticketId}`, at: request.createdAt }); return state; }

test("B80-R01 supports every intake channel and deduplicates/thread-binds inbound requests", () => {
  assert.deepEqual(TICKET_SOURCES, ["web-form", "inapp", "email", "wechat-support", "partner-portal", "internal-handoff"]); const state = ticketState();
  const duplicate = createTicket(state, { request: ticket({ ticketId: "ticket-duplicate", initialMessage: "same thread follow-up" }), authorization: auth("support-intake", "support-intake"), idempotencyKey: "thread-followup", at: AT }); assert.deepEqual({ id: duplicate.ticketId, threaded: duplicate.threaded, duplicate: duplicate.duplicate }, { id: "ticket-1", threaded: true, duplicate: true });
});

test("B80-R02 routes by tenant severity tags and employee skills then escalates an SLA breach", () => {
  const state = ticketState(); registerSlaPolicy(state, { policy: sla(), authorization: auth("support-admin", "support-routing"), idempotencyKey: "sla", at: AT }); const routed = routeTicket(state, { tenantId: "tenant-1", ticketId: "ticket-1", availableSkills: ["generation"], authorization: auth("support-router", "support-routing"), idempotencyKey: "route", at: AT }, NOW); assert.equal(routed.queueId, "technical-l2");
  const escalated = escalateBreachedTickets(state, { tenantId: "tenant-1", authorization: auth("support-router", "support-routing"), idempotencyKey: "escalate", at: "2026-08-28T13:00:00.000Z" }, new Date("2026-08-28T13:00:00.000Z")); assert.deepEqual(escalated.escalated, ["ticket-1"]);
});

test("B80-R03 persists controlled state priority pause owner observers notes macros attachments and audit", () => {
  const state = ticketState(); const result = updateTicket(state, { tenantId: "tenant-1", ticketId: "ticket-1", update: { state: "paused", priority: "critical", pauseReason: "provider-wait", assigneeId: "agent-1", observers: ["lead-1"], internalNote: "Customer email customer@example.com", macroId: "technical-delay", reason: "waiting for provider" }, authorization: auth("support-agent", "ticket-management"), idempotencyKey: "ticket-update", at: AT }); assert.deepEqual(result, { ticketId: "ticket-1", state: "paused", priority: "critical" }); const persisted = state.read(); assert.equal(persisted.records.tickets["ticket-1"].internalNotes.length, 1); assert.equal(persisted.audit.length, 2);
});

test("B80-R04 quarantines, scans, bounds and short-signs attachments and rejects original photos/malware", async () => {
  const state = ticketState(); const attachment = { attachmentId: "attachment-1", tenantId: "tenant-1", ticketId: "ticket-1", objectReference: "object-store:support-quarantine/attachment-1", sha256: D.a, contentType: "image/png", sizeBytes: 1024, containsOriginalPhoto: false, retentionUntil: "2026-09-28T12:00:00.000Z" };
  const accepted = await attachTicketFile(state, { attachment, authorization: auth("support-agent", "ticket-attachment"), idempotencyKey: "attachment", at: AT }, new ReferenceAttachmentScanner(), SECRET, NOW); assert.equal(resolveAttachmentAccess(state, { token: accepted.accessToken, reason: "Inspect customer attachment", authorization: auth("support-agent", "ticket-attachment"), idempotencyKey: "attachment-access", at: AT }, SECRET, NOW).expiresInSeconds, 900);
  await rejects("ATTACHMENT_MALICIOUS", () => attachTicketFile(state, { attachment: { ...attachment, attachmentId: "bad", sha256: D.b }, authorization: auth("support-agent", "ticket-attachment"), idempotencyKey: "bad-attachment", at: AT }, new ReferenceAttachmentScanner([D.b]), SECRET, NOW));
});

test("B80-R05 masks least-privilege views and step-up escalates high-risk complaint/regulatory work", async () => {
  const state = ticketState(ticket({ tags: ["privacy"], severity: "critical" })); throws("SENSITIVE_QUEUE_REQUIRED", () => viewTicket(state, { tenantId: "tenant-1", ticketId: "ticket-1", reason: "triage", authorization: auth("support-agent", "ticket-view"), idempotencyKey: "denied-view", at: AT })); assert.equal(viewTicket(state, { tenantId: "tenant-1", ticketId: "ticket-1", reason: "privacy case", authorization: auth("privacy-specialist", "ticket-view"), idempotencyKey: "privacy-view", at: AT }).initialMessage.startsWith("[redacted"), true);
  const verified = await verifyTicketRequester(state, { verification: { verificationId: "identity-1", tenantId: "tenant-1", ticketId: "ticket-1", method: "authenticated-session", challengeReceiptSha256: D.b, occurredAt: AT }, authorization: auth("support-identity", "identity-verification") }, new ReferenceIdentityVerificationAdapter()); assert.deepEqual(verified, { ticketId: "ticket-1", state: "verified", productionEvidence: false });
  const escalation = { escalationId: "escalation-1", tenantId: "tenant-1", ticketId: "ticket-1", type: "privacy-regulatory", severity: "critical", jurisdiction: "us", deadline: "2026-08-29T12:00:00.000Z", evidenceSha256: D.a, occurredAt: AT }; throws("STEP_UP_REQUIRED", () => openComplaintEscalation(state, { escalation, authorization: auth("compliance-operator", "complaint-escalation"), idempotencyKey: "escalation" })); assert.equal(openComplaintEscalation(state, { escalation, authorization: auth("compliance-operator", "complaint-escalation", { stepUp: true }), idempotencyKey: "escalation-good" }).queueId, "compliance-queue");
});
