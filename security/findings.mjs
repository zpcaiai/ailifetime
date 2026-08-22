import { canonicalSha256 } from "./lib/canonical.mjs";

const SLA_DAYS = Object.freeze({ critical: 1, high: 7, medium: 30, low: 90 });
const EXCEPTION_DAYS = Object.freeze({ critical: 7, high: 30, medium: 90, low: 180 });
const TRANSITIONS = Object.freeze({
  new: ["triaged", "false_positive"],
  triaged: ["remediation_in_progress", "risk_accepted", "false_positive"],
  remediation_in_progress: ["ready_for_retest", "risk_accepted"],
  ready_for_retest: ["remediation_in_progress", "closed"],
  risk_accepted: ["remediation_in_progress", "ready_for_retest"],
  false_positive: [],
  closed: [],
});

export function createFinding(input) {
  const id = identifier(input.id, "finding id");
  const severity = enumValue(input.severity, Object.keys(SLA_DAYS), "severity");
  const detectedAt = timestamp(input.detectedAt, "detectedAt");
  const ownerId = identifier(input.ownerId, "ownerId");
  const dueAt = new Date(Date.parse(detectedAt) + SLA_DAYS[severity] * 86_400_000).toISOString();
  const base = {
    version: "ltm.security-finding.v1",
    id,
    title: visible(input.title, "title", 300),
    severity,
    source: visible(input.source, "source", 200),
    sourceFindingKey: visible(input.sourceFindingKey, "sourceFindingKey", 300),
    ownerId,
    detectedAt,
    dueAt,
    status: "new",
    disclosureAssessment: {
      decision: "pending",
      ownerId,
      rationale: "Assessment required before closure",
      assessedAt: detectedAt,
    },
    events: [],
  };
  return applyFindingEvent(base, {
    to: "new",
    occurredAt: detectedAt,
    actorId: identifier(input.reporterId, "reporterId"),
    reason: visible(input.reason ?? "Security finding received", "reason", 1_000),
    ticketId: identifier(input.ticketId, "ticketId"),
    artifactSha256: digest(input.artifactSha256, "artifactSha256"),
  }, { initial: true });
}

export function applyFindingEvent(finding, input, options = {}) {
  validateShape(finding);
  const current = finding.status;
  const to = enumValue(input.to, Object.keys(TRANSITIONS), "event target status");
  if (options.initial !== true && !TRANSITIONS[current].includes(to)) throw new Error(`illegal finding transition ${current} -> ${to}`);
  if (options.initial === true && (finding.events.length !== 0 || current !== "new" || to !== "new")) throw new Error("initial event must create a new finding");
  const occurredAt = timestamp(input.occurredAt, "event occurredAt");
  const previous = finding.events.at(-1);
  if (previous !== undefined && Date.parse(occurredAt) < Date.parse(previous.occurredAt)) throw new Error("finding events must be chronological");
  const actorId = identifier(input.actorId, "event actorId");
  const details = transitionDetails(finding, current, to, input.details, actorId, occurredAt);
  const core = {
    sequence: finding.events.length + 1,
    from: options.initial === true ? null : current,
    to,
    occurredAt,
    actorId,
    reason: visible(input.reason, "event reason", 1_000),
    ticketId: identifier(input.ticketId, "event ticketId"),
    artifactSha256: digest(input.artifactSha256, "event artifactSha256"),
    details,
    previousHash: previous?.eventHash ?? "0".repeat(64),
  };
  const event = { ...core, eventHash: canonicalSha256(core) };
  const next = {
    ...finding,
    status: to,
    events: [...finding.events, event],
    ...(to === "risk_accepted" ? { exception: details.exception } : {}),
    ...(to !== "risk_accepted" && current === "risk_accepted" ? { exception: undefined } : {}),
    ...(details.disclosureAssessment === undefined ? {} : { disclosureAssessment: details.disclosureAssessment }),
    ...(details.ownerId === undefined ? {} : { ownerId: details.ownerId }),
  };
  if (next.exception === undefined) delete next.exception;
  validateFinding(next, { now: occurredAt, allowOpenOverdue: true });
  return next;
}

export function validateFinding(finding, options = {}) {
  validateShape(finding);
  const now = Date.parse(timestamp(options.now ?? new Date().toISOString(), "validation time"));
  const expectedDue = Date.parse(finding.detectedAt) + SLA_DAYS[finding.severity] * 86_400_000;
  if (Date.parse(finding.dueAt) > expectedDue) throw new Error("finding dueAt exceeds its severity SLA");
  let state = "new";
  let previousHash = "0".repeat(64);
  let previousTime = 0;
  for (let index = 0; index < finding.events.length; index += 1) {
    const event = finding.events[index];
    if (event.sequence !== index + 1 || event.previousHash !== previousHash) throw new Error("finding event chain sequence or previous hash is invalid");
    const { eventHash, ...core } = event;
    if (canonicalSha256(core) !== eventHash) throw new Error("finding event hash is invalid");
    const occurred = Date.parse(timestamp(event.occurredAt, "event occurredAt"));
    if (occurred < previousTime) throw new Error("finding events are out of order");
    if (index === 0) {
      if (event.from !== null || event.to !== "new") throw new Error("finding event chain must start at new");
    } else {
      if (event.from !== state || !TRANSITIONS[state].includes(event.to)) throw new Error(`illegal persisted finding transition ${event.from} -> ${event.to}`);
      transitionDetails(finding, state, event.to, event.details, event.actorId, event.occurredAt, true);
      state = event.to;
    }
    previousHash = eventHash;
    previousTime = occurred;
  }
  if (finding.events.length === 0 || finding.status !== state) throw new Error("finding status does not match its event chain");
  if (!identifier(finding.ownerId, "ownerId")) throw new Error("finding owner is required");
  validateDisclosure(finding.disclosureAssessment);
  if (finding.status === "risk_accepted") {
    validateException(finding, finding.exception, finding.events.at(-1)?.occurredAt);
    if (Date.parse(finding.exception.expiresAt) <= now) throw new Error("risk exception has expired and the finding must return to remediation");
  }
  if (!["closed", "false_positive"].includes(finding.status) && now > Date.parse(finding.dueAt) && options.allowOpenOverdue !== true) {
    throw new Error("open finding has breached its remediation SLA");
  }
  if (finding.status === "closed" && finding.disclosureAssessment.decision === "pending") throw new Error("closed finding requires a disclosure assessment decision");
  return { status: "PASS", findingId: finding.id, lifecycleState: finding.status };
}

export function validateFindingRegistry(findings, options = {}) {
  if (!Array.isArray(findings)) throw new Error("finding registry must be an array");
  const ids = new Set();
  const sourceKeys = new Set();
  const results = findings.map((finding) => {
    if (ids.has(finding.id) || sourceKeys.has(finding.sourceFindingKey)) throw new Error("finding registry contains a duplicate ID or source key");
    ids.add(finding.id); sourceKeys.add(finding.sourceFindingKey);
    return validateFinding(finding, options);
  });
  const unresolvedBlocking = findings.filter((finding) => ["critical", "high"].includes(finding.severity) && !["closed", "false_positive"].includes(finding.status));
  return { status: unresolvedBlocking.length === 0 ? "PASS" : "FAIL", findings: results.length, unresolvedBlocking: unresolvedBlocking.map((item) => item.id) };
}

function transitionDetails(finding, from, to, details, actorId, occurredAt, persisted = false) {
  const value = details === undefined ? {} : object(details, "event details");
  if (to === "triaged") {
    return { ownerId: identifier(value.ownerId, "triage ownerId"), classification: visible(value.classification, "classification", 200) };
  }
  if (to === "risk_accepted") {
    const exception = object(value.exception, "risk exception");
    validateException(finding, exception, occurredAt);
    return { exception };
  }
  if (to === "ready_for_retest") {
    return { remediationArtifactSha256: digest(value.remediationArtifactSha256, "remediation artifact digest") };
  }
  if (to === "closed") {
    const retest = object(value.retest, "retest");
    if (retest.result !== "passed" || identifier(retest.performedBy, "retest performer") === finding.ownerId) {
      throw new Error("closure requires a passing independent retest");
    }
    digest(retest.artifactSha256, "retest artifact digest");
    timestamp(retest.completedAt, "retest completedAt");
    const disclosureAssessment = validateDisclosure(value.disclosureAssessment);
    if (disclosureAssessment.decision === "pending") throw new Error("closure requires a completed disclosure assessment");
    return { retest, disclosureAssessment };
  }
  if (to === "false_positive") {
    const approval = object(value.approval, "false-positive approval");
    if (identifier(approval.approvedBy, "false-positive approver") === actorId) throw new Error("false-positive disposition requires independent approval");
    identifier(approval.approvalId, "false-positive approval ID");
    return { approval };
  }
  if (to === "remediation_in_progress") return { remediationPlan: visible(value.remediationPlan, "remediation plan", 2_000) };
  if (to === "new" && persisted) throw new Error("new is only allowed as the first event");
  return value;
}

function validateException(finding, exception, occurredAt) {
  const value = object(exception, "risk exception");
  identifier(value.approvalId, "exception approvalId");
  const approvedBy = identifier(value.approvedBy, "exception approvedBy");
  if (approvedBy === finding.ownerId) throw new Error("risk exception approver must be independent from the finding owner");
  identifier(value.riskOwnerId, "exception riskOwnerId");
  const approvedAt = timestamp(value.approvedAt, "exception approvedAt");
  const expiresAt = timestamp(value.expiresAt, "exception expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) throw new Error("risk exception must expire after approval");
  if (Date.parse(expiresAt) > Date.parse(approvedAt) + EXCEPTION_DAYS[finding.severity] * 86_400_000) throw new Error("risk exception exceeds its maximum duration");
  if (occurredAt !== undefined && Date.parse(approvedAt) > Date.parse(occurredAt)) throw new Error("risk exception approval cannot postdate its lifecycle event");
  if (!Array.isArray(value.compensatingControls) || value.compensatingControls.length === 0 || value.compensatingControls.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error("risk exception requires compensating controls");
  }
  visible(value.businessJustification, "exception business justification", 2_000);
  identifier(value.ticketId, "exception ticketId");
  return value;
}

function validateDisclosure(value) {
  const assessment = object(value, "disclosure assessment");
  enumValue(assessment.decision, ["required", "not_required", "pending"], "disclosure decision");
  identifier(assessment.ownerId, "disclosure ownerId");
  visible(assessment.rationale, "disclosure rationale", 2_000);
  timestamp(assessment.assessedAt, "disclosure assessedAt");
  return assessment;
}

function validateShape(finding) {
  object(finding, "finding");
  if (finding.version !== "ltm.security-finding.v1") throw new Error("unsupported finding version");
  identifier(finding.id, "finding id");
  enumValue(finding.severity, Object.keys(SLA_DAYS), "severity");
  timestamp(finding.detectedAt, "detectedAt"); timestamp(finding.dueAt, "dueAt");
  enumValue(finding.status, Object.keys(TRANSITIONS), "finding status");
  if (!Array.isArray(finding.events)) throw new Error("finding events must be an array");
}

function object(value, label) { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function identifier(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`); return value; }
function visible(value, label, maximum) { if (typeof value !== "string" || value.trim() === "" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`); return value.trim(); }
function digest(value, label) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`); return value; }
function timestamp(value, label) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO-8601 UTC timestamp`); return value; }
function enumValue(value, allowed, label) { if (!allowed.includes(value)) throw new Error(`${label} is invalid`); return value; }
