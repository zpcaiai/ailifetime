import { authorization, bool, digest, exact, fail, id, integer, iso, list, object, oneOf, redactText, sha256, signToken, text, verifyToken } from "./contracts.mjs";

const LOW_RISK_TOOLS = Object.freeze(["check-status", "resend-notification", "update-preference", "create-ticket"]);
const HIGH_RISK_TOOLS = Object.freeze(["refund", "delete-data", "change-ownership", "accept-consent", "export-private-media"]);
export const SUPPORT_ASSISTANT_DISCLOSURE = "I am an AI support assistant, not a future version of you, therapist, lawyer, insurer, or autonomous account operator.";

export function answerSupportQuestion(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-assistant"], purpose: "support-assistant" });
  const articleIds = list(input.authorizedArticleIds, "authorizedArticleIds", { maximum: 10, item: id }); const facts = list(input.authorizedFacts, "authorizedFacts", { maximum: 20, item: (item, index) => { exact(item, ["factId", "source", "value"], `authorizedFacts[${index}]`); return { factId: id(item.factId, "factId"), source: id(item.source, "source"), value: redactText(item.value) }; } });
  const articles = articleIds.map((articleId) => store.read().records.articles[`${tenantId}:${articleId}`]).map((aggregate) => aggregate?.versions[aggregate.currentVersion]).filter((article) => article?.state === "published" && new Date(article.expiresAt) > now);
  if (articles.length !== articleIds.length) fail("ASSISTANT_KNOWLEDGE_NOT_APPROVED", "assistant may answer only from current approved knowledge");
  if (!bool(input.accountContextAuthorized, "accountContextAuthorized") && facts.length > 0) fail("ASSISTANT_CONTEXT_DENIED", "account facts require user authorization");
  const answer = articles.length === 0 ? null : `${articles[0].recoverySteps.join(" ")} ${facts.map((fact) => fact.value).join(" ")}`.trim();
  return { schemaVersion: "ltm.support-assistant-answer.v1", disclosure: SUPPORT_ASSISTANT_DISCLOSURE, answer, citations: articles.map((article) => ({ articleId: article.articleId, version: article.version })), factSources: facts.map(({ factId, source }) => ({ factId, source })), capabilities: LOW_RISK_TOOLS, handoffRequired: answer === null, noPredictionOrProfessionalAdvice: true };
}

export function previewSupportToolCall(input, secret, now = new Date()) {
  const request = object(input.request, "tool request"); exact(request, ["operationId", "tenantId", "ticketId", "tool", "parameters", "expectedEffect", "expiresInSeconds"], "tool request");
  const tenantId = id(request.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["support-assistant"], purpose: "support-tool" });
  const tool = id(request.tool, "tool"); if (HIGH_RISK_TOOLS.includes(tool)) fail("HIGH_RISK_TOOL_FORBIDDEN", "assistant cannot execute high-risk support actions"); if (!LOW_RISK_TOOLS.includes(tool)) fail("TOOL_NOT_ALLOWLISTED", "tool is not allowlisted");
  const parameters = object(request.parameters, "parameters"); if (Object.keys(parameters).length > 20 || JSON.stringify(parameters).length > 4000) fail("TOOL_PARAMETERS_INVALID", "tool parameters are not bounded");
  const operationId = id(request.operationId, "operationId"); const iat = Math.floor(now.getTime() / 1000); const claims = { schemaVersion: "ltm.support-tool-preview.v1", audience: "support-tool-confirm", operationId, tenantId, ticketId: id(request.ticketId, "ticketId"), tool, parametersSha256: sha256(parameters), actorId: auth.actorId, iat, exp: iat + integer(request.expiresInSeconds, "expiresInSeconds", 60, 900) };
  return { operationId, tool, expectedEffect: text(request.expectedEffect, "expectedEffect", 1000), parametersSha256: claims.parametersSha256, confirmationToken: signToken(claims, secret), requiresExplicitConfirmation: true };
}

export class SupportToolExecutor { async execute(_request) { fail("SUPPORT_TOOL_EXECUTOR_REQUIRED", "tool executor must be implemented"); } }
export class ReferenceSupportToolExecutor extends SupportToolExecutor { constructor() { super(); this.results = new Map(); } async execute(request) { const prior = this.results.get(request.operationId); if (prior !== undefined) return prior; const result = { operationId: request.operationId, tool: request.tool, state: "completed", domainReceiptSha256: sha256(request), productionEvidence: false }; this.results.set(request.operationId, result); return result; } }

export async function confirmSupportToolCall(store, input, secret, executor, now = new Date()) {
  if (!(executor instanceof SupportToolExecutor)) fail("SUPPORT_TOOL_EXECUTOR_REQUIRED", "tool executor is required");
  const claims = verifyToken(input.confirmationToken, secret, { schemaVersion: "ltm.support-tool-preview.v1", audience: "support-tool-confirm" }, now);
  const auth = authorization(input.authorization, { tenantId: claims.tenantId, roles: ["support-assistant"], purpose: "support-tool" });
  if (auth.actorId !== claims.actorId || sha256(input.parameters) !== claims.parametersSha256) fail("TOOL_CONFIRMATION_MISMATCH", "confirmation is not bound to actor and parameters");
  const plan = store.transact({ authorization: input.authorization, tenantId: claims.tenantId, purpose: "support-tool", action: "assistant-tool.plan", subject: claims.operationId, idempotencyKey: claims.operationId, at: input.at, input: { claims, parameters: input.parameters } }, (records) => { const operation = { operationId: claims.operationId, tenantId: claims.tenantId, ticketId: claims.ticketId, tool: claims.tool, parametersSha256: claims.parametersSha256, state: "executing", actorId: auth.actorId, plannedAt: input.at, domainReceiptSha256: null }; records.toolOperations[claims.operationId] = operation; return operation; });
  if (plan.state === "completed") return plan;
  const result = await executor.execute({ operationId: claims.operationId, tenantId: claims.tenantId, ticketId: claims.ticketId, tool: claims.tool, parameters: input.parameters });
  return store.transact({ authorization: input.authorization, tenantId: claims.tenantId, purpose: "support-tool", action: "assistant-tool.complete", subject: claims.operationId, idempotencyKey: `${claims.operationId}:receipt`, at: input.at, input: result }, (records) => { const operation = records.toolOperations[claims.operationId]; operation.state = oneOf(result.state, ["completed", "failed"], "state"); operation.domainReceiptSha256 = digest(result.domainReceiptSha256, "domainReceiptSha256"); operation.productionEvidence = bool(result.productionEvidence, "productionEvidence"); operation.completedAt = input.at; return operation; });
}

export function determineHumanHandoff(input) {
  const signals = object(input.signals, "handoff signals"); exact(signals, ["answerAvailable", "userRequested", "negativeExperience", "paymentDispute", "childMatter", "privacyMatter", "safetyMatter", "securityMatter"], "handoff signals");
  const reasons = Object.entries(signals).filter(([key, value]) => key === "answerAvailable" ? !bool(value, key) : bool(value, key)).map(([key]) => key === "answerAvailable" ? "no-approved-answer" : key);
  return { handoffRequired: reasons.length > 0, reasons, queue: reasons.some((reason) => ["childMatter", "privacyMatter", "safetyMatter", "securityMatter"].includes(reason)) ? "specialist-support" : reasons.includes("paymentDispute") ? "payment-disputes" : "general-support" };
}

export function createHandoffSummary(store, input) {
  const summary = object(input.summary, "handoff summary"); exact(summary, ["handoffId", "tenantId", "ticketId", "userStatements", "systemFacts", "modelInferences", "toolOperationIds", "includesFullFutureSelfConversation", "createdAt"], "handoff summary");
  const tenantId = id(summary.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-assistant"], purpose: "support-handoff" });
  if (bool(summary.includesFullFutureSelfConversation, "includesFullFutureSelfConversation")) fail("PRIVATE_CONVERSATION_HANDOFF_FORBIDDEN", "full future-self conversations are excluded by default");
  const normalized = { schemaVersion: "ltm.support-handoff.v1", handoffId: id(summary.handoffId, "handoffId"), tenantId, ticketId: id(summary.ticketId, "ticketId"), userStatements: list(summary.userStatements, "userStatements", { maximum: 10, item: (item, label) => redactText(text(item, label, 1000)) }), systemFacts: list(summary.systemFacts, "systemFacts", { maximum: 20, item: (item, index) => { exact(item, ["factId", "source", "valueSha256"], `systemFacts[${index}]`); return { factId: id(item.factId, "factId"), source: id(item.source, "source"), valueSha256: digest(item.valueSha256, "valueSha256") }; } }), modelInferences: list(summary.modelInferences, "modelInferences", { maximum: 5, item: (item, index) => { exact(item, ["statement", "confidenceBasisPoints"], `modelInferences[${index}]`); return { statement: redactText(item.statement), confidenceBasisPoints: integer(item.confidenceBasisPoints, "confidenceBasisPoints", 0, 10_000) }; } }), toolOperationIds: list(summary.toolOperationIds, "toolOperationIds", { maximum: 20, item: id }), includesFullFutureSelfConversation: false, createdAt: iso(summary.createdAt, "createdAt") };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "support-handoff", action: "handoff.create", subject: normalized.handoffId, idempotencyKey: input.idempotencyKey, at: normalized.createdAt, input: normalized }, (records) => { for (const operationId of normalized.toolOperationIds) if (records.toolOperations[operationId] === undefined) fail("HANDOFF_TOOL_HISTORY_MISSING", "handoff must include valid executed tool history"); records.handoffs[normalized.handoffId] = normalized; return { handoffId: normalized.handoffId, ticketId: normalized.ticketId, minimized: true }; });
}

export function recordAssistantEvaluation(store, input) {
  const evaluation = object(input.evaluation, "assistant evaluation"); exact(evaluation, ["evaluationId", "tenantId", "caseType", "correct", "resolved", "misleading", "unauthorizedToolCall", "handoffQualityBasisPoints", "satisfactionBasisPoints", "redTeam", "evidenceSha256", "occurredAt"], "assistant evaluation");
  const tenantId = id(evaluation.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["support-quality"], purpose: "assistant-quality" });
  const normalized = { evaluationId: id(evaluation.evaluationId, "evaluationId"), tenantId, caseType: id(evaluation.caseType, "caseType"), correct: bool(evaluation.correct, "correct"), resolved: bool(evaluation.resolved, "resolved"), misleading: bool(evaluation.misleading, "misleading"), unauthorizedToolCall: bool(evaluation.unauthorizedToolCall, "unauthorizedToolCall"), handoffQualityBasisPoints: integer(evaluation.handoffQualityBasisPoints, "handoffQualityBasisPoints", 0, 10_000), satisfactionBasisPoints: integer(evaluation.satisfactionBasisPoints, "satisfactionBasisPoints", 0, 10_000), redTeam: bool(evaluation.redTeam, "redTeam"), evidenceSha256: digest(evaluation.evidenceSha256, "evidenceSha256"), occurredAt: iso(evaluation.occurredAt, "occurredAt") };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "assistant-quality", action: "assistant.evaluate", subject: normalized.evaluationId, idempotencyKey: normalized.evaluationId, at: normalized.occurredAt, input: normalized }, (records) => { records.evaluations.push(normalized); return { evaluationId: normalized.evaluationId, passed: normalized.correct && !normalized.misleading && !normalized.unauthorizedToolCall }; });
}
