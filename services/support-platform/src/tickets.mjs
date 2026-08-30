import { authorization, bool, digest, exact, fail, id, integer, iso, list, object, oneOf, redactText, sha256, signToken, text, verifyToken } from "./contracts.mjs";

export const TICKET_SOURCES = Object.freeze(["web-form", "inapp", "email", "wechat-support", "partner-portal", "internal-handoff"]);
export const TICKET_TAGS = Object.freeze(["payment", "privacy", "child", "safety", "technical", "shipping", "partner", "general"]);

export class AttachmentScanner {
  async scan(_attachment) { fail("ATTACHMENT_SCANNER_REQUIRED", "attachment scanner must be implemented"); }
}
export class ReferenceAttachmentScanner extends AttachmentScanner {
  constructor(blockedSha256 = []) { super(); this.blocked = new Set(blockedSha256); }
  async scan(attachment) { const result = this.blocked.has(attachment.sha256) ? "malicious" : "clean"; return { scanner: "reference-static-scanner", result, receiptSha256: sha256({ scanner: "reference-static-scanner", attachment: attachment.sha256, result }), productionEvidence: false }; }
}

export class IdentityVerificationAdapter {
  async verify(_request) { fail("IDENTITY_VERIFICATION_ADAPTER_REQUIRED", "identity verification adapter must be implemented"); }
}
export class ReferenceIdentityVerificationAdapter extends IdentityVerificationAdapter {
  async verify(request) { return { verificationId: request.verificationId, ticketId: request.ticketId, state: "verified", subjectReferenceSha256: request.subjectReferenceSha256, evidenceSha256: sha256(request), verifiedAt: request.occurredAt, productionEvidence: false }; }
}

export function registerSlaPolicy(store, input) {
  const policy = object(input.policy, "SLA policy"); exact(policy, ["policyId", "tenantId", "severity", "tags", "firstResponseMinutes", "resolutionMinutes", "queueId", "escalationQueueId", "requiredSkills", "version", "expiresAt"], "SLA policy");
  const tenantId = id(policy.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-admin"], purpose: "support-routing" });
  const normalized = { policyId: id(policy.policyId, "policyId"), tenantId, severity: oneOf(policy.severity, ["low", "normal", "high", "critical"], "severity"), tags: list(policy.tags, "tags", { minimum: 1, maximum: 8, item: (item, label) => oneOf(item, TICKET_TAGS, label) }), firstResponseMinutes: integer(policy.firstResponseMinutes, "firstResponseMinutes", 1, 10080), resolutionMinutes: integer(policy.resolutionMinutes, "resolutionMinutes", 1, 43200), queueId: id(policy.queueId, "queueId"), escalationQueueId: id(policy.escalationQueueId, "escalationQueueId"), requiredSkills: list(policy.requiredSkills, "requiredSkills", { minimum: 1, maximum: 30, item: id }), version: id(policy.version, "version"), expiresAt: iso(policy.expiresAt, "expiresAt") };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "support-routing", action: "sla-policy.register", subject: normalized.policyId, idempotencyKey: input.idempotencyKey, at: input.at, input: normalized }, (records) => { records.slaPolicies[`${tenantId}:${normalized.policyId}`] = normalized; return { policyId: normalized.policyId, version: normalized.version }; });
}

export function createTicket(store, input) {
  const request = object(input.request, "ticket request");
  exact(request, ["ticketId", "tenantId", "source", "externalThreadId", "requesterReference", "requesterVerification", "product", "locale", "severity", "tags", "summary", "initialMessage", "containsOriginalPhoto", "createdAt"], "ticket request");
  const tenantId = id(request.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-intake", "partner-support-intake"], purpose: "support-intake" });
  if (bool(request.containsOriginalPhoto, "containsOriginalPhoto")) fail("ORIGINAL_PHOTO_NOT_REQUESTED", "support intake must not request original photos by default");
  const normalized = { schemaVersion: "ltm.support-ticket.v1", ticketId: id(request.ticketId, "ticketId"), tenantId, source: oneOf(request.source, TICKET_SOURCES, "source"), externalThreadId: id(request.externalThreadId, "externalThreadId"), requesterReference: text(request.requesterReference, "requesterReference", 512), requesterVerification: oneOf(request.requesterVerification, ["anonymous", "pending"], "requesterVerification"), requesterVerificationEvidenceSha256: null, requesterVerifiedAt: null, requesterVerificationProductionEvidence: false, product: id(request.product, "product"), locale: text(request.locale, "locale", 16), severity: oneOf(request.severity, ["low", "normal", "high", "critical"], "severity"), tags: list(request.tags, "tags", { minimum: 1, maximum: 8, item: (item, label) => oneOf(item, TICKET_TAGS, label) }), summary: redactText(request.summary), initialMessage: redactText(request.initialMessage), state: "open", priority: request.severity, pauseReason: null, assigneeId: null, observers: [], internalNotes: [], macroHistory: [], attachments: [], queueId: null, sla: null, createdAt: iso(request.createdAt, "createdAt"), updatedAt: iso(request.createdAt, "createdAt"), history: [] };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "support-intake", action: "ticket.create", subject: normalized.ticketId, idempotencyKey: input.idempotencyKey, at: normalized.createdAt, input: normalized }, (records) => {
    const threadKey = `${tenantId}:${normalized.source}:${normalized.externalThreadId}`; const existingTicketId = records.inboundThreads[threadKey];
    if (existingTicketId !== undefined) { const existing = records.tickets[existingTicketId]; existing.updatedAt = normalized.updatedAt; existing.history.push({ operation: "thread-message", messageSha256: sha256(normalized.initialMessage), at: normalized.updatedAt }); return { ticketId: existing.ticketId, threaded: true, duplicate: true }; }
    if (records.tickets[normalized.ticketId] !== undefined) fail("TICKET_ID_CONFLICT", "ticket identifier already exists"); records.inboundThreads[threadKey] = normalized.ticketId; normalized.history.push({ operation: "created", actorId: input.authorization.actorId, at: normalized.createdAt }); records.tickets[normalized.ticketId] = normalized;
    return { ticketId: normalized.ticketId, threaded: false, duplicate: false };
  });
}

export async function verifyTicketRequester(store, input, adapter) {
  if (!(adapter instanceof IdentityVerificationAdapter)) fail("IDENTITY_VERIFICATION_ADAPTER_REQUIRED", "identity verification adapter is required"); const verification = object(input.verification, "identity verification"); exact(verification, ["verificationId", "tenantId", "ticketId", "method", "challengeReceiptSha256", "occurredAt"], "identity verification"); const tenantId = id(verification.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-identity", "partner-identity"], purpose: "identity-verification" }); const ticketId = id(verification.ticketId, "ticketId"); const ticket = store.read().records.tickets[ticketId]; if (ticket?.tenantId !== tenantId || ticket.requesterVerification !== "pending") fail("IDENTITY_VERIFICATION_STATE_INVALID", "ticket is unavailable or not pending verification"); const request = { verificationId: id(verification.verificationId, "verificationId"), tenantId, ticketId, method: oneOf(verification.method, ["authenticated-session", "email-challenge", "sms-challenge", "partner-sso"], "method"), challengeReceiptSha256: digest(verification.challengeReceiptSha256, "challengeReceiptSha256"), subjectReferenceSha256: sha256(ticket.requesterReference), occurredAt: iso(verification.occurredAt, "occurredAt") }; const receipt = await adapter.verify(request);
  return store.transact({ authorization: input.authorization, tenantId, purpose: "identity-verification", action: "ticket.identity-verify", subject: ticketId, idempotencyKey: request.verificationId, at: request.occurredAt, input: { request, receipt } }, (records) => { const current = records.tickets[ticketId]; if (current?.tenantId !== tenantId || current.requesterVerification !== "pending") fail("IDENTITY_VERIFICATION_STATE_INVALID", "ticket verification state changed"); if (receipt.verificationId !== request.verificationId || receipt.ticketId !== ticketId || receipt.subjectReferenceSha256 !== request.subjectReferenceSha256) fail("IDENTITY_VERIFICATION_RECEIPT_MISMATCH", "identity receipt is not bound to the ticket requester"); current.requesterVerification = oneOf(receipt.state, ["verified", "rejected"], "state"); current.requesterVerificationEvidenceSha256 = digest(receipt.evidenceSha256, "evidenceSha256"); current.requesterVerifiedAt = iso(receipt.verifiedAt, "verifiedAt"); current.requesterVerificationProductionEvidence = bool(receipt.productionEvidence, "productionEvidence"); current.history.push({ operation: "requester-verification", state: current.requesterVerification, evidenceSha256: current.requesterVerificationEvidenceSha256, at: current.requesterVerifiedAt }); return { ticketId, state: current.requesterVerification, productionEvidence: current.requesterVerificationProductionEvidence }; });
}

export function routeTicket(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-router"], purpose: "support-routing" });
  const skills = list(input.availableSkills, "availableSkills", { minimum: 1, maximum: 50, item: id });
  return store.transact({ authorization: input.authorization, tenantId, purpose: "support-routing", action: "ticket.route", subject: input.ticketId, idempotencyKey: input.idempotencyKey, at: input.at, input: { ticketId: input.ticketId, availableSkills: skills } }, (records) => {
    const ticket = records.tickets[id(input.ticketId, "ticketId")]; if (ticket?.tenantId !== tenantId) fail("TICKET_NOT_FOUND", "ticket is unavailable");
    const policies = Object.values(records.slaPolicies).filter((policy) => policy.tenantId === tenantId && policy.severity === ticket.severity && policy.tags.some((tag) => ticket.tags.includes(tag)) && policy.requiredSkills.every((skill) => skills.includes(skill)) && new Date(policy.expiresAt) > now);
    if (policies.length === 0) fail("SLA_ROUTE_UNAVAILABLE", "no current skilled SLA route exists");
    const policy = policies.sort((left, right) => left.firstResponseMinutes - right.firstResponseMinutes)[0];
    ticket.queueId = policy.queueId; ticket.sla = { policyId: policy.policyId, firstResponseDueAt: new Date(new Date(ticket.createdAt).getTime() + policy.firstResponseMinutes * 60_000).toISOString(), resolutionDueAt: new Date(new Date(ticket.createdAt).getTime() + policy.resolutionMinutes * 60_000).toISOString(), breached: false }; ticket.history.push({ operation: "routed", queueId: ticket.queueId, at: input.at });
    return { ticketId: ticket.ticketId, queueId: ticket.queueId, sla: ticket.sla };
  });
}

export function escalateBreachedTickets(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-router"], purpose: "support-routing" });
  return store.transact({ authorization: input.authorization, tenantId, purpose: "support-routing", action: "ticket.escalate", subject: tenantId, idempotencyKey: input.idempotencyKey, at: input.at, input: { now: now.toISOString() } }, (records) => {
    const escalated = [];
    for (const ticket of Object.values(records.tickets).filter((item) => item.tenantId === tenantId && !["resolved", "closed"].includes(item.state) && item.sla !== null && new Date(item.sla.firstResponseDueAt) <= now)) {
      const policy = records.slaPolicies[`${tenantId}:${ticket.sla.policyId}`]; ticket.queueId = policy.escalationQueueId; ticket.sla.breached = true; ticket.priority = ticket.priority === "critical" ? "critical" : "high"; ticket.history.push({ operation: "sla-escalated", queueId: ticket.queueId, at: input.at }); escalated.push(ticket.ticketId);
    }
    return { escalated, count: escalated.length };
  });
}

export function updateTicket(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["support-agent", "support-lead"], purpose: "ticket-management" });
  const update = object(input.update, "ticket update"); exact(update, ["state", "priority", "pauseReason", "assigneeId", "observers", "internalNote", "macroId", "reason"], "ticket update");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "ticket-management", action: "ticket.update", subject: input.ticketId, idempotencyKey: input.idempotencyKey, at: input.at, input: update }, (records) => {
    const ticket = records.tickets[id(input.ticketId, "ticketId")]; if (ticket?.tenantId !== tenantId) fail("TICKET_NOT_FOUND", "ticket is unavailable");
    const nextState = oneOf(update.state, ["open", "pending-customer", "pending-provider", "paused", "resolved", "closed"], "state");
    if (nextState === "closed" && ticket.state !== "resolved") fail("TICKET_STATE_INVALID", "ticket must be resolved before closure");
    if (nextState === "paused" && update.pauseReason === null) fail("TICKET_PAUSE_REASON_REQUIRED", "pause reason is required");
    ticket.state = nextState; ticket.priority = oneOf(update.priority, ["low", "normal", "high", "critical"], "priority"); ticket.pauseReason = update.pauseReason === null ? null : id(update.pauseReason, "pauseReason"); ticket.assigneeId = update.assigneeId === null ? null : id(update.assigneeId, "assigneeId"); ticket.observers = list(update.observers, "observers", { maximum: 20, item: id });
    if (update.internalNote !== null) ticket.internalNotes.push({ noteSha256: sha256(redactText(update.internalNote)), actorId: auth.actorId, at: input.at });
    if (update.macroId !== null) { if (ticket.tags.some((tag) => ["privacy", "child", "safety"].includes(tag))) fail("SENSITIVE_MACRO_FORBIDDEN", "sensitive tickets cannot use an unreviewed macro"); ticket.macroHistory.push({ macroId: id(update.macroId, "macroId"), at: input.at }); }
    ticket.updatedAt = input.at; ticket.history.push({ operation: "updated", state: ticket.state, reason: text(update.reason, "reason", 1000), actorId: auth.actorId, at: input.at }); return { ticketId: ticket.ticketId, state: ticket.state, priority: ticket.priority };
  });
}

export async function attachTicketFile(store, input, scanner, secret, now = new Date()) {
  if (!(scanner instanceof AttachmentScanner)) fail("ATTACHMENT_SCANNER_REQUIRED", "scanner adapter is required");
  const attachment = object(input.attachment, "attachment"); exact(attachment, ["attachmentId", "tenantId", "ticketId", "objectReference", "sha256", "contentType", "sizeBytes", "containsOriginalPhoto", "retentionUntil"], "attachment");
  const tenantId = id(attachment.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-agent", "support-intake"], purpose: "ticket-attachment" });
  if (bool(attachment.containsOriginalPhoto, "containsOriginalPhoto")) fail("ORIGINAL_PHOTO_NOT_REQUESTED", "original photos require a separate governed intake");
  const normalized = { attachmentId: id(attachment.attachmentId, "attachmentId"), tenantId, ticketId: id(attachment.ticketId, "ticketId"), objectReference: text(attachment.objectReference, "objectReference", 512), sha256: digest(attachment.sha256, "sha256"), contentType: oneOf(attachment.contentType, ["image/png", "image/jpeg", "application/pdf", "text/plain"], "contentType"), sizeBytes: integer(attachment.sizeBytes, "sizeBytes", 1, 10_000_000), containsOriginalPhoto: false, retentionUntil: iso(attachment.retentionUntil, "retentionUntil") };
  if (!normalized.objectReference.startsWith("object-store:support-quarantine/")) fail("ATTACHMENT_REFERENCE_INVALID", "attachment must originate in quarantine object storage"); if (new Date(normalized.retentionUntil) <= now) fail("ATTACHMENT_RETENTION_INVALID", "attachment retention has expired");
  const scan = await scanner.scan(normalized); if (scan.result !== "clean") fail("ATTACHMENT_MALICIOUS", "attachment did not pass malware scanning");
  const stored = store.transact({ authorization: input.authorization, tenantId, purpose: "ticket-attachment", action: "attachment.accept", subject: normalized.attachmentId, idempotencyKey: input.idempotencyKey, at: input.at, input: { normalized, scan } }, (records) => { const ticket = records.tickets[normalized.ticketId]; if (ticket?.tenantId !== tenantId) fail("TICKET_NOT_FOUND", "ticket is unavailable"); if (records.attachments[normalized.attachmentId] !== undefined) fail("ATTACHMENT_ID_CONFLICT", "attachment identifier already exists"); const record = { ...normalized, scanReceiptSha256: digest(scan.receiptSha256, "scanReceiptSha256"), scanProductionEvidence: bool(scan.productionEvidence, "productionEvidence"), state: "available" }; records.attachments[record.attachmentId] = record; ticket.attachments.push(record.attachmentId); return record; });
  const iat = Math.floor(now.getTime() / 1000); return { ...stored, accessToken: signToken({ schemaVersion: "ltm.support-attachment.v1", audience: "support-attachment", tenantId, ticketId: stored.ticketId, attachmentId: stored.attachmentId, iat, exp: iat + 900 }, secret) };
}

export function resolveAttachmentAccess(store, input, secret, now = new Date()) {
  const claims = verifyToken(input.token, secret, { schemaVersion: "ltm.support-attachment.v1", audience: "support-attachment" }, now); const auth = authorization(input.authorization, { tenantId: claims.tenantId, roles: ["support-agent"], purpose: "ticket-attachment" });
  const reason = text(input.reason, "reason", 1000); return store.transact({ authorization: input.authorization, tenantId: claims.tenantId, purpose: "ticket-attachment", action: "attachment.access", subject: claims.attachmentId, idempotencyKey: input.idempotencyKey, at: input.at, input: { tokenSha256: sha256(input.token), reason } }, (records) => { const attachment = records.attachments[claims.attachmentId]; if (attachment?.ticketId !== claims.ticketId || attachment.state !== "available" || new Date(attachment.retentionUntil) <= now) fail("ATTACHMENT_GONE", "attachment is unavailable"); return { objectReference: attachment.objectReference, expiresInSeconds: claims.exp - Math.floor(now.getTime() / 1000), accessAudit: { actorId: auth.actorId, ticketId: claims.ticketId, reason } }; });
}

export function viewTicket(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["support-agent", "support-lead", "privacy-specialist"], purpose: "ticket-view" });
  const ticketId = id(input.ticketId, "ticketId"); const reason = text(input.reason, "reason", 1000); return store.transact({ authorization: input.authorization, tenantId, purpose: "ticket-view", action: "ticket.view", subject: ticketId, idempotencyKey: input.idempotencyKey, at: input.at, input: { reason } }, (records) => { const ticket = records.tickets[ticketId]; if (ticket?.tenantId !== tenantId) fail("TICKET_NOT_FOUND", "ticket is unavailable"); const sensitive = ticket.tags.some((tag) => ["privacy", "child", "safety"].includes(tag)); if (sensitive && !auth.roles.some((role) => ["support-lead", "privacy-specialist"].includes(role))) fail("SENSITIVE_QUEUE_REQUIRED", "sensitive ticket requires a specialist queue"); return { ...ticket, requesterReference: auth.roles.includes("privacy-specialist") ? ticket.requesterReference : "[masked]", initialMessage: "[redacted; access through scoped transcript API]", internalNotes: [], accessReason: reason }; });
}

export function openComplaintEscalation(store, input) {
  const escalation = object(input.escalation, "complaint escalation"); exact(escalation, ["escalationId", "tenantId", "ticketId", "type", "severity", "jurisdiction", "deadline", "evidenceSha256", "occurredAt"], "complaint escalation");
  const tenantId = id(escalation.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["support-lead", "compliance-operator"], purpose: "complaint-escalation", stepUp: true });
  const normalized = { escalationId: id(escalation.escalationId, "escalationId"), tenantId, ticketId: id(escalation.ticketId, "ticketId"), type: oneOf(escalation.type, ["complaint", "payment-dispute", "privacy-regulatory", "child-safety", "security-regulatory"], "type"), severity: oneOf(escalation.severity, ["high", "critical"], "severity"), jurisdiction: id(escalation.jurisdiction, "jurisdiction"), deadline: iso(escalation.deadline, "deadline"), evidenceSha256: digest(escalation.evidenceSha256, "evidenceSha256"), occurredAt: iso(escalation.occurredAt, "occurredAt"), state: "open", ownerRole: escalation.type.includes("regulatory") ? "compliance" : "specialist-support" };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "complaint-escalation", action: "complaint.open", subject: normalized.escalationId, idempotencyKey: input.idempotencyKey, at: normalized.occurredAt, input: normalized }, (records) => { const ticket = records.tickets[normalized.ticketId]; if (ticket?.tenantId !== tenantId) fail("TICKET_NOT_FOUND", "ticket is unavailable"); if (records.complaints[normalized.escalationId] !== undefined) fail("COMPLAINT_ID_CONFLICT", "complaint identifier already exists"); ticket.priority = "critical"; ticket.queueId = `${normalized.ownerRole}-queue`; records.complaints[normalized.escalationId] = { ...normalized, openedBy: auth.actorId, history: [{ state: "open", at: normalized.occurredAt }] }; return { escalationId: normalized.escalationId, queueId: ticket.queueId, deadline: normalized.deadline }; });
}
