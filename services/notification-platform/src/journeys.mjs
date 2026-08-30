import { authorization, bool, digest, exact, fail, id, integer, iso, list, object, oneOf, sha256, text } from "./contracts.mjs";
import { NOTIFICATION_PURPOSES } from "./preferences.mjs";

export const APPROVED_AUDIENCE_ATTRIBUTES = Object.freeze(["account-age-days", "plan", "region", "locale", "purchase-count", "family-role", "generation-count", "partner-tier", "onboarding-stage"]);
const EXIT_EVENTS = Object.freeze(["payment", "refund", "data-deleted", "unsubscribe", "authorization-revoked", "crisis-signal", "minor-status-changed", "support-ticket-opened"]);

function journeyNode(value, index) {
  const node = object(value, `nodes[${index}]`); exact(node, ["nodeId", "type", "next", "eventType", "attribute", "operator", "value", "waitSeconds", "templateId", "purpose", "maximumExecutions"], `nodes[${index}]`);
  const type = oneOf(node.type, ["trigger", "condition", "wait", "branch", "send", "goal", "exit"], "node type");
  const attribute = node.attribute === null ? null : oneOf(node.attribute, APPROVED_AUDIENCE_ATTRIBUTES, "attribute");
  const next = list(node.next, "next", { maximum: 4, item: id }); const eventType = node.eventType === null ? null : id(node.eventType, "eventType"); const operator = node.operator === null ? null : oneOf(node.operator, ["eq", "neq", "gte", "lte", "in"], "operator"); const waitSeconds = node.waitSeconds === null ? null : integer(node.waitSeconds, "waitSeconds", 1, 31_536_000); const templateId = node.templateId === null ? null : id(node.templateId, "templateId"); const purpose = node.purpose === null ? null : oneOf(node.purpose, NOTIFICATION_PURPOSES, "purpose");
  if (type === "trigger" && (eventType === null || next.length !== 1)) fail("JOURNEY_TRIGGER_INVALID", "trigger nodes require eventType and one next node");
  if (["condition", "branch"].includes(type) && (attribute === null || operator === null || node.value === null || next.length !== 2)) fail("JOURNEY_CONDITION_INVALID", "condition/branch nodes require attribute, operator, value and true/false edges");
  if (type === "wait" && (waitSeconds === null || next.length !== 1)) fail("JOURNEY_WAIT_INVALID", "wait nodes require duration and one next node");
  if (type === "send" && (templateId === null || purpose === null || next.length > 1)) fail("JOURNEY_SEND_INVALID", "send nodes require template and purpose with at most one next node");
  if (["goal", "exit"].includes(type) && next.length !== 0) fail("JOURNEY_TERMINAL_INVALID", "goal and exit nodes cannot have outgoing edges");
  return { nodeId: id(node.nodeId, "nodeId"), type, next, eventType, attribute, operator, value: node.value, waitSeconds, templateId, purpose, maximumExecutions: integer(node.maximumExecutions, "maximumExecutions", 1, 100) };
}

export function validateJourneyDefinition(value) {
  const journey = object(value, "journey");
  exact(journey, ["journeyId", "tenantId", "version", "name", "state", "entryEvent", "nodes", "entryNodeId", "exitEvents", "timeZoneMode", "frequencyCap", "maximumEnrollments", "rolloutPercent", "estimatedAudience", "estimatedCostMicros", "simulationSha256", "approvals", "createdAt", "expiresAt"], "journey");
  const nodes = list(journey.nodes, "nodes", { minimum: 2, maximum: 200, item: journeyNode });
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) fail("JOURNEY_NODE_DUPLICATE", "journey node IDs must be unique");
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  for (const node of nodes) for (const next of node.next) if (!nodeIds.has(next)) fail("JOURNEY_EDGE_INVALID", "journey edge references a missing node");
  const entryNodeId = id(journey.entryNodeId, "entryNodeId"); if (!nodeIds.has(entryNodeId)) fail("JOURNEY_ENTRY_INVALID", "entry node is unavailable");
  const exitEvents = list(journey.exitEvents, "exitEvents", { minimum: 1, maximum: 30, item: id });
  for (const mandatory of EXIT_EVENTS) if (!exitEvents.includes(mandatory)) fail("JOURNEY_EXIT_INCOMPLETE", `${mandatory} exit handling is required`);
  const approvals = list(journey.approvals, "approvals", { maximum: 10, item: (item, index) => { exact(item, ["actorId", "role", "evidenceSha256", "approvedAt"], `approvals[${index}]`); return { actorId: id(item.actorId, "actorId"), role: oneOf(item.role, ["marketing", "privacy", "finance", "safety"], "role"), evidenceSha256: digest(item.evidenceSha256, "evidenceSha256"), approvedAt: iso(item.approvedAt, "approvedAt") }; } });
  const createdAt = iso(journey.createdAt, "createdAt"); const expiresAt = iso(journey.expiresAt, "expiresAt"); if (new Date(expiresAt) <= new Date(createdAt)) fail("JOURNEY_WINDOW_INVALID", "journey expiry must follow creation");
  return { schemaVersion: "ltm.journey-definition.v1", journeyId: id(journey.journeyId, "journeyId"), tenantId: id(journey.tenantId, "tenantId"), version: id(journey.version, "version"), name: text(journey.name, "name", 200), state: oneOf(journey.state, ["draft", "approved", "active", "paused", "stopped", "expired"], "state"), entryEvent: id(journey.entryEvent, "entryEvent"), nodes, entryNodeId, exitEvents, timeZoneMode: oneOf(journey.timeZoneMode, ["contact", "tenant", "utc"], "timeZoneMode"), frequencyCap: integer(journey.frequencyCap, "frequencyCap", 1, 100), maximumEnrollments: integer(journey.maximumEnrollments, "maximumEnrollments", 1, 10_000_000), rolloutPercent: integer(journey.rolloutPercent, "rolloutPercent", 0, 100), estimatedAudience: integer(journey.estimatedAudience, "estimatedAudience", 0, 10_000_000), estimatedCostMicros: integer(journey.estimatedCostMicros, "estimatedCostMicros", 0, 10_000_000_000), simulationSha256: digest(journey.simulationSha256, "simulationSha256"), approvals, createdAt, expiresAt };
}

export function saveJourneyVersion(store, input) {
  const journey = validateJourneyDefinition(input.journey); authorization(input.authorization, { tenantId: journey.tenantId, roles: ["journey-editor"], purpose: "journey-management" });
  if (journey.state !== "draft") fail("JOURNEY_STATE_INVALID", "new journey version must be draft");
  return store.transact({ authorization: input.authorization, tenantId: journey.tenantId, purpose: "journey-management", action: "journey.save", subject: `${journey.journeyId}:${journey.version}`, idempotencyKey: input.idempotencyKey, at: input.at, input: journey }, (records) => {
    const key = `${journey.tenantId}:${journey.journeyId}`; const aggregate = records.journeys[key] ?? { versions: {}, currentVersion: null, enrollments: {}, history: [] };
    if (aggregate.versions[journey.version] !== undefined) fail("JOURNEY_VERSION_IMMUTABLE", "journey version exists");
    aggregate.versions[journey.version] = journey; aggregate.history.push({ operation: "saved", version: journey.version, at: input.at }); records.journeys[key] = aggregate;
    return { journeyId: journey.journeyId, version: journey.version, state: "draft" };
  });
}

export function publishJourney(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["journey-publisher"], purpose: "journey-management" }); if (!auth.stepUp) fail("STEP_UP_REQUIRED", "journey publication requires step-up");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-management", action: "journey.publish", subject: `${input.journeyId}:${input.version}`, idempotencyKey: input.idempotencyKey, at: input.at, input: { journeyId: input.journeyId, version: input.version, stopSwitchArmed: input.stopSwitchArmed } }, (records) => {
    const aggregate = records.journeys[`${tenantId}:${id(input.journeyId, "journeyId")}`]; const journey = aggregate?.versions[id(input.version, "version")];
    if (journey === undefined || new Date(journey.expiresAt) <= now) fail("JOURNEY_NOT_CURRENT", "journey is missing or expired");
    if (!bool(input.stopSwitchArmed, "stopSwitchArmed")) fail("JOURNEY_STOP_SWITCH_REQUIRED", "stop switch must be armed");
    if (journey.estimatedAudience > journey.maximumEnrollments) fail("JOURNEY_AUDIENCE_LIMIT", "estimated audience exceeds hard limit");
    if (journey.simulationSha256 === "0".repeat(64)) fail("JOURNEY_SIMULATION_REQUIRED", "simulation evidence is required");
    if (!journey.approvals.some((item) => item.role === "marketing") || !journey.approvals.some((item) => item.role === "privacy") || new Set(journey.approvals.map((item) => item.actorId)).size < 2) fail("TWO_PERSON_APPROVAL_REQUIRED", "distinct marketing and privacy approvals are required");
    journey.state = "active"; aggregate.currentVersion = journey.version; aggregate.history.push({ operation: "published", version: journey.version, rolloutPercent: journey.rolloutPercent, actorId: auth.actorId, at: input.at });
    return { journeyId: journey.journeyId, version: journey.version, state: "active", estimatedAudience: journey.estimatedAudience, estimatedCostMicros: journey.estimatedCostMicros, rolloutPercent: journey.rolloutPercent };
  });
}

export function processJourneyEvent(store, input) {
  const event = object(input.event, "journey event"); exact(event, ["eventId", "tenantId", "subjectId", "eventType", "attributes", "timeZone", "occurredAt"], "journey event");
  const tenantId = id(event.tenantId, "tenantId"); const subjectId = id(event.subjectId, "subjectId"); const eventType = id(event.eventType, "eventType");
  authorization(input.authorization, { tenantId, roles: ["journey-worker"], purpose: "journey-execution" });
  const attributes = object(event.attributes, "attributes"); for (const key of Object.keys(attributes)) if (!APPROVED_AUDIENCE_ATTRIBUTES.includes(key)) fail("AUDIENCE_ATTRIBUTE_FORBIDDEN", `${key} is not approved for journey targeting`);
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-execution", action: "journey.event", subject: id(event.eventId, "eventId"), idempotencyKey: id(event.eventId, "eventId"), at: event.occurredAt, input: event }, (records) => {
    const results = [];
    for (const aggregate of Object.values(records.journeys)) {
      const journey = aggregate.versions[aggregate.currentVersion]; if (journey?.tenantId !== tenantId || journey.state !== "active") continue;
      const enrollmentId = sha256({ tenantId, journeyId: journey.journeyId, version: journey.version, subjectId }).slice(0, 32); const enrollment = aggregate.enrollments[enrollmentId];
      if (journey.exitEvents.includes(eventType) && enrollment !== undefined) { enrollment.state = eventType === "crisis-signal" ? "safety-paused" : "exited"; enrollment.exitReason = eventType; enrollment.updatedAt = event.occurredAt; results.push({ journeyId: journey.journeyId, enrollmentId, state: enrollment.state }); continue; }
      if (eventType !== journey.entryEvent || enrollment !== undefined) continue;
      if (Number.parseInt(sha256(subjectId).slice(0, 8), 16) % 100 >= journey.rolloutPercent) { results.push({ journeyId: journey.journeyId, state: "rollout-holdback" }); continue; }
      const next = { enrollmentId, journeyId: journey.journeyId, journeyVersion: journey.version, subjectId, state: "active", currentNodeId: journey.entryNodeId, attributes, timeZone: text(event.timeZone, "timeZone", 64), executions: 0, nodeExecutions: {}, sendExecutions: 0, createdAt: event.occurredAt, updatedAt: event.occurredAt, exitReason: null };
      aggregate.enrollments[enrollmentId] = next;
      const taskId = sha256({ tenantId, enrollmentId, nodeId: journey.entryNodeId, ordinal: 0 }).slice(0, 32); records.tasks[taskId] = { taskId, tenantId, journeyId: journey.journeyId, journeyVersion: journey.version, enrollmentId, nodeId: journey.entryNodeId, state: "scheduled", dueAt: event.occurredAt, attempts: 0, lastError: null };
      results.push({ journeyId: journey.journeyId, enrollmentId, taskId, state: "active" });
    }
    return { eventId: event.eventId, results };
  });
}

function matchesCondition(node, attributes) {
  const actual = attributes[node.attribute]; const expected = node.value;
  if (actual === undefined) return node.operator === "neq";
  if (node.operator === "eq") return sha256(actual) === sha256(expected);
  if (node.operator === "neq") return sha256(actual) !== sha256(expected);
  if (["gte", "lte"].includes(node.operator)) {
    if (typeof actual !== "number" || typeof expected !== "number" || !Number.isFinite(actual) || !Number.isFinite(expected)) fail("JOURNEY_CONDITION_VALUE_INVALID", "ordered comparison requires finite numbers");
    return node.operator === "gte" ? actual >= expected : actual <= expected;
  }
  if (!Array.isArray(expected) || expected.length > 100) fail("JOURNEY_CONDITION_VALUE_INVALID", "in comparison requires a bounded array");
  return expected.some((candidate) => sha256(candidate) === sha256(actual));
}

export function advanceJourneyTask(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["journey-worker"], purpose: "journey-execution" });
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-execution", action: "journey.task-advance", subject: input.taskId, idempotencyKey: input.idempotencyKey, at: input.at, input: { taskId: input.taskId, now: now.toISOString() } }, (records) => {
    const task = records.tasks[id(input.taskId, "taskId")]; if (task?.tenantId !== tenantId || task.state !== "claimed") fail("JOURNEY_TASK_STATE_INVALID", "task is not claimed");
    const aggregate = records.journeys[`${tenantId}:${task.journeyId}`]; const journey = aggregate?.versions[task.journeyVersion]; const enrollment = aggregate?.enrollments[task.enrollmentId];
    if (journey?.state !== "active" || enrollment?.state !== "active") fail("JOURNEY_EXECUTION_REVOKED", "journey or enrollment is no longer active");
    const node = journey.nodes.find((candidate) => candidate.nodeId === task.nodeId); if (node === undefined || enrollment.currentNodeId !== node.nodeId) fail("JOURNEY_NODE_STATE_INVALID", "task node does not match the enrollment");
    enrollment.nodeExecutions ??= {}; enrollment.sendExecutions ??= 0; const priorExecutions = enrollment.nodeExecutions[node.nodeId] ?? 0;
    const complete = (outcome, nextNodeId = null, dueAt = null, outbound = null) => {
      task.state = "completed"; task.outcome = outcome; task.completedAt = input.at; enrollment.nodeExecutions[node.nodeId] = priorExecutions + 1; enrollment.executions += 1; enrollment.updatedAt = input.at;
      let nextTask = null;
      if (nextNodeId !== null && enrollment.state === "active") { enrollment.currentNodeId = nextNodeId; const taskId = sha256({ tenantId, enrollmentId: enrollment.enrollmentId, nodeId: nextNodeId, ordinal: enrollment.executions }).slice(0, 32); nextTask = { taskId, tenantId, journeyId: journey.journeyId, journeyVersion: journey.version, enrollmentId: enrollment.enrollmentId, nodeId: nextNodeId, state: "scheduled", dueAt, attempts: 0, lastError: null }; records.tasks[taskId] = nextTask; }
      return { taskId: task.taskId, outcome, enrollmentState: enrollment.state, nextTask, outbound };
    };
    if (priorExecutions >= node.maximumExecutions) { enrollment.state = "exited"; enrollment.exitReason = "node-execution-cap"; return complete("exited"); }
    if (node.type === "exit" || node.type === "goal") { enrollment.state = "exited"; enrollment.exitReason = node.type === "goal" ? "goal-reached" : "journey-complete"; return complete(node.type === "goal" ? "goal-reached" : "exited"); }
    let nextNodeId = node.next[0]; let dueAt = now.toISOString(); let outcome = "advanced"; let outbound = null;
    if (["condition", "branch"].includes(node.type)) nextNodeId = node.next[matchesCondition(node, enrollment.attributes) ? 0 : 1];
    if (node.type === "wait") dueAt = new Date(now.getTime() + node.waitSeconds * 1000).toISOString();
    if (node.type === "send") {
      if (enrollment.sendExecutions >= journey.frequencyCap) outcome = "skipped-frequency";
      else { enrollment.sendExecutions += 1; outcome = "sent"; outbound = { schemaVersion: "ltm.journey-send-plan.v1", tenantId, journeyId: journey.journeyId, journeyVersion: journey.version, enrollmentId: enrollment.enrollmentId, subjectId: enrollment.subjectId, templateId: node.templateId, purpose: node.purpose, timeZone: enrollment.timeZone, attributesSha256: sha256(enrollment.attributes), idempotencyKey: `${enrollment.enrollmentId}:${node.nodeId}:${priorExecutions}` }; }
    }
    return complete(outcome, nextNodeId ?? null, dueAt, outbound);
  });
}

export function claimDueJourneyTasks(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["journey-worker"], purpose: "journey-execution" });
  const limit = integer(input.limit, "limit", 1, 100);
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-execution", action: "journey.tasks-claim", subject: tenantId, idempotencyKey: input.idempotencyKey, at: input.at, input: { limit, now: now.toISOString() } }, (records) => {
    const tasks = Object.values(records.tasks).filter((task) => task.tenantId === tenantId && ["scheduled", "retry"].includes(task.state) && new Date(task.dueAt) <= now).sort((left, right) => left.dueAt.localeCompare(right.dueAt)).slice(0, limit);
    for (const task of tasks) { task.state = "claimed"; task.claimedAt = input.at; }
    return tasks;
  });
}

export function completeJourneyTask(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["journey-worker"], purpose: "journey-execution" });
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-execution", action: "journey.task-complete", subject: input.taskId, idempotencyKey: input.idempotencyKey, at: input.at, input: { taskId: input.taskId, outcome: input.outcome } }, (records) => {
    const task = records.tasks[id(input.taskId, "taskId")]; if (task?.tenantId !== tenantId || task.state !== "claimed") fail("JOURNEY_TASK_STATE_INVALID", "task is not claimable");
    task.state = "completed"; task.outcome = oneOf(input.outcome, ["sent", "skipped-frequency", "goal-reached", "exited"], "outcome"); task.completedAt = input.at;
    return task;
  });
}

export function failJourneyTask(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["journey-worker"], purpose: "journey-execution" });
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-execution", action: "journey.task-fail", subject: input.taskId, idempotencyKey: input.idempotencyKey, at: input.at, input: { taskId: input.taskId, errorCode: input.errorCode } }, (records) => {
    const task = records.tasks[id(input.taskId, "taskId")]; if (task?.tenantId !== tenantId || task.state !== "claimed") fail("JOURNEY_TASK_STATE_INVALID", "task is not claimed");
    task.attempts += 1; task.lastError = id(input.errorCode, "errorCode");
    if (task.attempts >= 3) { task.state = "dead-letter"; records.dlq[task.taskId] = structuredClone(task); }
    else { task.state = "retry"; task.dueAt = new Date(new Date(input.at).getTime() + 2 ** task.attempts * 60_000).toISOString(); }
    return task;
  });
}

export function replayDeadLetterTask(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["journey-operator"], purpose: "journey-replay" }); if (!auth.stepUp) fail("STEP_UP_REQUIRED", "dead-letter replay requires step-up");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-replay", action: "journey.dlq-replay", subject: input.taskId, idempotencyKey: input.idempotencyKey, at: input.at, input: { taskId: input.taskId, reason: input.reason } }, (records) => {
    const task = records.dlq[id(input.taskId, "taskId")]; if (task?.tenantId !== tenantId) fail("DLQ_TASK_NOT_FOUND", "dead-letter task is unavailable");
    const aggregate = records.journeys[`${tenantId}:${task.journeyId}`]; const enrollment = aggregate?.enrollments[task.enrollmentId];
    if (enrollment === undefined || enrollment.state !== "active") fail("DLQ_REPLAY_FORBIDDEN", "replay cannot resurrect an exited or revoked enrollment");
    task.state = "retry"; task.attempts = 0; task.dueAt = input.at; task.lastError = null; records.tasks[task.taskId] = task; delete records.dlq[task.taskId];
    return { taskId: task.taskId, state: "retry", reason: text(input.reason, "reason", 1000) };
  });
}

export function setJourneyStop(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["journey-operator", "safety-operator"], purpose: "journey-management" }); if (!auth.stepUp) fail("STEP_UP_REQUIRED", "journey stop requires step-up");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "journey-management", action: "journey.stop", subject: input.journeyId, idempotencyKey: input.idempotencyKey, at: input.at, input: { journeyId: input.journeyId, reason: input.reason, globalSafety: input.globalSafety } }, (records) => {
    const targets = bool(input.globalSafety, "globalSafety") ? Object.values(records.journeys).filter((aggregate) => aggregate.versions[aggregate.currentVersion]?.tenantId === tenantId) : [records.journeys[`${tenantId}:${id(input.journeyId, "journeyId")}`]];
    for (const aggregate of targets) { if (aggregate === undefined) continue; const journey = aggregate.versions[aggregate.currentVersion]; journey.state = "paused"; aggregate.history.push({ operation: "paused", reason: text(input.reason, "reason", 1000), actorId: auth.actorId, at: input.at }); }
    return { paused: targets.filter(Boolean).length, globalSafety: input.globalSafety };
  });
}
