import assert from "node:assert/strict";
import test from "node:test";
import { answerSupportQuestion, confirmSupportToolCall, createHandoffSummary, determineHumanHandoff, previewSupportToolCall, publishHelpArticle, recordAssistantEvaluation, ReferenceSupportToolExecutor, SUPPORT_ASSISTANT_DISCLOSURE } from "../src/index.mjs";
import { article, AT, auth, D, NOW, SECRET, store } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }
async function rejects(code, operation) { await assert.rejects(operation, (error) => error?.code === code); }
function knowledgeState() { const state = store(); publishHelpArticle(state, { article: article(), authorization: auth("knowledge-publisher", "knowledge-management", { stepUp: true }), idempotencyKey: "assistant-article", at: AT }, NOW); return state; }
function toolRequest(overrides = {}) { return { operationId: "tool-operation-1", tenantId: "tenant-1", ticketId: "ticket-1", tool: "check-status", parameters: { resourceId: "generation-1" }, expectedEffect: "Read current generation status", expiresInSeconds: 300, ...overrides }; }

test("B81-R01 answers only from approved knowledge and authorized account facts with an explicit AI boundary", () => {
  const result = answerSupportQuestion(knowledgeState(), { tenantId: "tenant-1", authorizedArticleIds: ["generation-help"], authorizedFacts: [{ factId: "status-1", source: "generation-service", value: "Job is retryable" }], accountContextAuthorized: true, authorization: auth("support-assistant", "support-assistant") }, NOW); assert.equal(result.disclosure, SUPPORT_ASSISTANT_DISCLOSURE); assert.deepEqual(result.citations, [{ articleId: "generation-help", version: "v1" }]);
  throws("ASSISTANT_CONTEXT_DENIED", () => answerSupportQuestion(knowledgeState(), { tenantId: "tenant-1", authorizedArticleIds: ["generation-help"], authorizedFacts: [{ factId: "status-1", source: "generation-service", value: "private" }], accountContextAuthorized: false, authorization: auth("support-assistant", "support-assistant") }, NOW));
});

test("B81-R02 tool calls are allowlisted preview-confirmed authorized idempotent audited and prohibit refund/delete", async () => {
  const state = store(); const request = toolRequest(); const preview = previewSupportToolCall({ request, authorization: auth("support-assistant", "support-tool") }, SECRET, NOW); const executor = new ReferenceSupportToolExecutor(); const input = { confirmationToken: preview.confirmationToken, parameters: request.parameters, authorization: auth("support-assistant", "support-tool"), at: AT };
  assert.equal((await confirmSupportToolCall(state, input, SECRET, executor, NOW)).state, "completed"); assert.equal((await confirmSupportToolCall(state, input, SECRET, executor, NOW)).state, "completed"); assert.equal(state.read().records.toolOperations[request.operationId].productionEvidence, false);
  throws("HIGH_RISK_TOOL_FORBIDDEN", () => previewSupportToolCall({ request: toolRequest({ operationId: "refund-attempt", tool: "refund" }), authorization: auth("support-assistant", "support-tool") }, SECRET, NOW));
  await rejects("TOOL_CONFIRMATION_MISMATCH", () => confirmSupportToolCall(state, { ...input, parameters: { resourceId: "different" } }, SECRET, executor, NOW));
});

test("B81-R03 routes no-answer user requests negative experience disputes and child/privacy/safety/security to humans", () => {
  const ordinary = determineHumanHandoff({ signals: { answerAvailable: true, userRequested: false, negativeExperience: false, paymentDispute: false, childMatter: false, privacyMatter: false, safetyMatter: false, securityMatter: false } }); assert.equal(ordinary.handoffRequired, false);
  const sensitive = determineHumanHandoff({ signals: { answerAvailable: true, userRequested: false, negativeExperience: false, paymentDispute: false, childMatter: true, privacyMatter: false, safetyMatter: false, securityMatter: false } }); assert.deepEqual({ required: sensitive.handoffRequired, queue: sensitive.queue }, { required: true, queue: "specialist-support" });
});

test("B81-R04 human handoff separates minimized statements facts and inferences and rejects full private dialogue", () => {
  const state = store(); const summary = { handoffId: "handoff-1", tenantId: "tenant-1", ticketId: "ticket-1", userStatements: ["Customer says the job failed"], systemFacts: [{ factId: "generation-state", source: "generation-service", valueSha256: D.a }], modelInferences: [{ statement: "May be a timeout", confidenceBasisPoints: 5000 }], toolOperationIds: [], includesFullFutureSelfConversation: false, createdAt: AT };
  assert.equal(createHandoffSummary(state, { summary, authorization: auth("support-assistant", "support-handoff"), idempotencyKey: "handoff", at: AT }).minimized, true);
  throws("PRIVATE_CONVERSATION_HANDOFF_FORBIDDEN", () => createHandoffSummary(state, { summary: { ...summary, handoffId: "handoff-private", includesFullFutureSelfConversation: true }, authorization: auth("support-assistant", "support-handoff"), idempotencyKey: "handoff-private", at: AT }));
});

test("B81-R05 records correctness resolution misleading unauthorized-tool handoff satisfaction and red-team evidence", () => {
  const state = store(); const evaluation = { evaluationId: "assistant-eval-1", tenantId: "tenant-1", caseType: "privacy-red-team", correct: true, resolved: true, misleading: false, unauthorizedToolCall: false, handoffQualityBasisPoints: 9000, satisfactionBasisPoints: 8500, redTeam: true, evidenceSha256: D.a, occurredAt: AT };
  assert.equal(recordAssistantEvaluation(state, { evaluation, authorization: auth("support-quality", "assistant-quality") }).passed, true); assert.equal(state.read().records.evaluations[0].redTeam, true);
});
