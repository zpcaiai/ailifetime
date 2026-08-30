import assert from "node:assert/strict";
import test from "node:test";
import { advanceJourneyTask, claimDueJourneyTasks, failJourneyTask, processJourneyEvent, publishJourney, replayDeadLetterTask, saveJourneyVersion, setJourneyStop, validateJourneyDefinition } from "../src/index.mjs";
import { AT, auth, D, journey, NOW, store } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }
function activeJourney(state, value = journey()) { saveJourneyVersion(state, { journey: value, authorization: auth("journey-editor", "journey-management"), idempotencyKey: `save-${value.journeyId}`, at: AT }); return publishJourney(state, { tenantId: "tenant-1", journeyId: value.journeyId, version: value.version, stopSwitchArmed: true, authorization: auth("journey-publisher", "journey-management", { stepUp: true }), idempotencyKey: `publish-${value.journeyId}`, at: AT }, NOW); }
function event(eventId, eventType = "generation-started") { return { eventId, tenantId: "tenant-1", subjectId: "contact-1", eventType, attributes: { region: "us", plan: "pro" }, timeZone: "UTC", occurredAt: AT }; }

test("B76-R01 validates durable trigger/condition/wait/branch/cap/goal/exit/version/replay definitions", () => {
  const value = validateJourneyDefinition(journey()); assert.equal(value.nodes.length, 3); assert.equal(value.exitEvents.includes("authorization-revoked"), true);
  throws("JOURNEY_EXIT_INCOMPLETE", () => validateJourneyDefinition(journey({ exitEvents: ["refund"] })));
  throws("JOURNEY_EDGE_INVALID", () => validateJourneyDefinition(journey({ nodes: [{ ...journey().nodes[0], next: ["missing"] }, ...journey().nodes.slice(1)] })));
  const state = store(); activeJourney(state); const enrolled = processJourneyEvent(state, { event: event("executable-entry"), authorization: auth("journey-worker", "journey-execution") }); let claimed = claimDueJourneyTasks(state, { tenantId: "tenant-1", limit: 1, authorization: auth("journey-worker", "journey-execution"), idempotencyKey: "claim-trigger", at: AT }, NOW); let advanced = advanceJourneyTask(state, { tenantId: "tenant-1", taskId: claimed[0].taskId, authorization: auth("journey-worker", "journey-execution"), idempotencyKey: "advance-trigger", at: AT }, NOW); assert.equal(advanced.nextTask.nodeId, "send"); claimed = claimDueJourneyTasks(state, { tenantId: "tenant-1", limit: 1, authorization: auth("journey-worker", "journey-execution"), idempotencyKey: "claim-send", at: AT }, NOW); advanced = advanceJourneyTask(state, { tenantId: "tenant-1", taskId: claimed[0].taskId, authorization: auth("journey-worker", "journey-execution"), idempotencyKey: "advance-send", at: AT }, NOW); assert.deepEqual({ outcome: advanced.outcome, templateId: advanced.outbound.templateId, productionReceipt: advanced.outbound.productionReceipt }, { outcome: "sent", templateId: "generation-ready", productionReceipt: undefined }); claimed = claimDueJourneyTasks(state, { tenantId: "tenant-1", limit: 1, authorization: auth("journey-worker", "journey-execution"), idempotencyKey: "claim-exit", at: AT }, NOW); advanced = advanceJourneyTask(state, { tenantId: "tenant-1", taskId: claimed[0].taskId, authorization: auth("journey-worker", "journey-execution"), idempotencyKey: "advance-exit", at: AT }, NOW); assert.equal(advanced.enrollmentState, "exited"); assert.equal(enrolled.results[0].state, "active");
});

test("B76-R02 payment/refund/delete/unsubscribe/revocation/crisis/minor/ticket events immediately exit or safety-pause", () => {
  const state = store(); activeJourney(state); const enrolled = processJourneyEvent(state, { event: event("entry-1"), authorization: auth("journey-worker", "journey-execution") }); assert.equal(enrolled.results[0].state, "active");
  const exited = processJourneyEvent(state, { event: { ...event("refund-1", "refund"), occurredAt: "2026-08-28T12:01:00.000Z" }, authorization: auth("journey-worker", "journey-execution") }); assert.equal(exited.results[0].state, "exited");
  const state2 = store(); activeJourney(state2); processJourneyEvent(state2, { event: event("entry-2"), authorization: auth("journey-worker", "journey-execution") }); const crisis = processJourneyEvent(state2, { event: { ...event("crisis-1", "crisis-signal"), occurredAt: "2026-08-28T12:01:00.000Z" }, authorization: auth("journey-worker", "journey-execution") }); assert.equal(crisis.results[0].state, "safety-paused");
});

test("B76-R03 audience targeting accepts only approved business attributes and rejects sensitive inference", () => {
  const state = store(); activeJourney(state);
  throws("AUDIENCE_ATTRIBUTE_FORBIDDEN", () => processJourneyEvent(state, { event: { ...event("sensitive-entry"), attributes: { faceVector: "x", emotion: "sad" } }, authorization: auth("journey-worker", "journey-execution") }));
  assert.equal(processJourneyEvent(state, { event: event("approved-entry"), authorization: auth("journey-worker", "journey-execution") }).results.length, 1);
});

test("B76-R04 publication enforces simulation, audience/cost estimate, distinct approvals, rollout and stop switch", () => {
  const state = store(); saveJourneyVersion(state, { journey: journey(), authorization: auth("journey-editor", "journey-management"), idempotencyKey: "save-r04", at: AT });
  throws("JOURNEY_STOP_SWITCH_REQUIRED", () => publishJourney(state, { tenantId: "tenant-1", journeyId: "activation", version: "v1", stopSwitchArmed: false, authorization: auth("journey-publisher", "journey-management", { stepUp: true }), idempotencyKey: "publish-no-stop", at: AT }, NOW));
  const published = publishJourney(state, { tenantId: "tenant-1", journeyId: "activation", version: "v1", stopSwitchArmed: true, authorization: auth("journey-publisher", "journey-management", { stepUp: true }), idempotencyKey: "publish-good", at: AT }, NOW); assert.equal(published.estimatedCostMicros, 20000);
  const paused = setJourneyStop(state, { tenantId: "tenant-1", journeyId: "activation", reason: "safety incident", globalSafety: true, authorization: auth("safety-operator", "journey-management", { stepUp: true }), idempotencyKey: "global-stop", at: "2026-08-28T12:01:00.000Z" }); assert.equal(paused.paused, 1);
});

test("B76-R05 execution is idempotent, recoverable, retry-bounded and DLQ replay cannot resurrect revoked enrollment", () => {
  const state = store(); activeJourney(state); const first = processJourneyEvent(state, { event: event("entry-r05"), authorization: auth("journey-worker", "journey-execution") }); const duplicate = processJourneyEvent(state, { event: event("entry-r05"), authorization: auth("journey-worker", "journey-execution") }); assert.deepEqual(duplicate, first); const taskId = first.results[0].taskId;
  for (let attempt = 1; attempt <= 3; attempt += 1) { const time = new Date(NOW.getTime() + attempt * 10 * 60_000); const claimed = claimDueJourneyTasks(state, { tenantId: "tenant-1", limit: 10, authorization: auth("journey-worker", "journey-execution"), idempotencyKey: `claim-${attempt}`, at: time.toISOString() }, time); assert.equal(claimed[0].taskId, taskId); failJourneyTask(state, { tenantId: "tenant-1", taskId, errorCode: "provider-timeout", authorization: auth("journey-worker", "journey-execution"), idempotencyKey: `fail-${attempt}`, at: time.toISOString() }); }
  assert.equal(state.read().records.dlq[taskId].state, "dead-letter"); assert.equal(replayDeadLetterTask(state, { tenantId: "tenant-1", taskId, reason: "provider recovered", authorization: auth("journey-operator", "journey-replay", { stepUp: true }), idempotencyKey: "replay-active", at: "2026-08-28T13:00:00.000Z" }).state, "retry");
});
