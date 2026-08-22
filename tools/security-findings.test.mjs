import assert from "node:assert/strict";
import test from "node:test";
import { applyFindingEvent, createFinding, validateFinding, validateFindingRegistry } from "../security/findings.mjs";

const digest = "a".repeat(64);
function initial() {
  return createFinding({
    id: "SEC-2026-001", title: "Synthetic authorization finding", severity: "high", source: "dast",
    sourceFindingKey: "dast:authorization:001", ownerId: "owner-security", reporterId: "scanner-service",
    detectedAt: "2026-08-20T00:00:00Z", reason: "Negative security regression failed", ticketId: "TICKET-1", artifactSha256: digest,
  });
}
function event(to, occurredAt, details = {}) { return { to, occurredAt, actorId: "owner-security", reason: `Move to ${to}`, ticketId: "TICKET-1", artifactSha256: digest, details }; }

test("enforces owner, SLA, immutable event chain, independent retest, and disclosure assessment", () => {
  let finding = initial();
  finding = applyFindingEvent(finding, event("triaged", "2026-08-20T01:00:00Z", { ownerId: "owner-security", classification: "authorization" }));
  finding = applyFindingEvent(finding, event("remediation_in_progress", "2026-08-20T02:00:00Z", { remediationPlan: "Enforce server-side ownership before lookup" }));
  finding = applyFindingEvent(finding, event("ready_for_retest", "2026-08-20T03:00:00Z", { remediationArtifactSha256: digest }));
  finding = applyFindingEvent(finding, event("closed", "2026-08-20T04:00:00Z", {
    retest: { result: "passed", performedBy: "independent-retester", artifactSha256: digest, completedAt: "2026-08-20T03:30:00Z" },
    disclosureAssessment: { decision: "not_required", ownerId: "legal-owner", rationale: "No customer data exposure occurred", assessedAt: "2026-08-20T03:45:00Z" },
  }));
  assert.equal(validateFinding(finding, { now: "2026-08-21T00:00:00Z" }).status, "PASS");
  assert.equal(validateFindingRegistry([finding]).status, "PASS");
  const tampered = structuredClone(finding); tampered.events[1].reason = "tampered";
  assert.throws(() => validateFinding(tampered), /hash/);
});

test("rejects expired or self-approved exceptions and blocks unresolved high findings", () => {
  let finding = initial();
  finding = applyFindingEvent(finding, event("triaged", "2026-08-20T01:00:00Z", { ownerId: "owner-security", classification: "authorization" }));
  assert.throws(() => applyFindingEvent(finding, event("risk_accepted", "2026-08-20T02:00:00Z", { exception: {
    approvalId: "APPROVAL-1", approvedBy: "owner-security", riskOwnerId: "risk-owner", approvedAt: "2026-08-20T01:30:00Z",
    expiresAt: "2026-08-21T01:30:00Z", compensatingControls: ["WAF deny rule"], businessJustification: "Short migration window", ticketId: "TICKET-1",
  } })), /independent/);
  finding = applyFindingEvent(finding, event("risk_accepted", "2026-08-20T02:00:00Z", { exception: {
    approvalId: "APPROVAL-2", approvedBy: "risk-committee", riskOwnerId: "risk-owner", approvedAt: "2026-08-20T01:30:00Z",
    expiresAt: "2026-08-21T01:30:00Z", compensatingControls: ["WAF deny rule"], businessJustification: "Short migration window", ticketId: "TICKET-1",
  } }));
  assert.throws(() => validateFinding(finding, { now: "2026-08-22T00:00:00Z" }), /expired/);
  assert.equal(validateFindingRegistry([finding], { now: "2026-08-20T12:00:00Z" }).status, "FAIL");
});
