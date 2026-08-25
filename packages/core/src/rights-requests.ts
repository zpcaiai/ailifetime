import { canonicalJson, sha256 } from "./canonical.js";
import { DomainError } from "./errors.js";
import type { ActorContext, JsonObject, RecordEnvelope } from "./types.js";

export const RIGHTS_REQUEST_COLLECTION = "privacy.rights-requests";
export const RIGHTS_REQUEST_SCHEMA_VERSION = "ltm.privacy-rights-request.v1";
export const RIGHTS_WORKFLOW_POLICY_VERSION = "ltm.product-rights-sla.v1";

export const RIGHTS_REQUEST_TYPES = [
  "access",
  "correction",
  "export",
  "withdraw",
  "delete",
  "restrict_processing",
  "appeal",
] as const;
export type RightsRequestType = typeof RIGHTS_REQUEST_TYPES[number];

export const RIGHTS_PROPAGATION_TARGETS = [
  "primary_record_store",
  "object_storage",
  "cache",
  "derived_artifacts",
  "search_index",
  "processing_queue",
  "log_references",
  "downstream_processors",
] as const;
export type RightsPropagationTarget = typeof RIGHTS_PROPAGATION_TARGETS[number];

export type RightsRequestStatus =
  | "propagation_pending"
  | "review_pending"
  | "awaiting_second_review"
  | "escalated"
  | "completed"
  | "denied";
export type RightsTaskState = "pending" | "succeeded" | "blocked" | "failed";
export type RightsReceiptOutcome = Exclude<RightsTaskState, "pending">;
export type RightsReviewDecision = "approve" | "deny";

export type RightsRequesterCapacity = "self" | "guardian" | "authorized_agent";

export interface RightsRequestScope extends JsonObject {
  readonly subjectResource: string;
  readonly requestedProcessingPurpose: string;
  readonly action: `rights.${RightsRequestType}`;
}

export interface RightsTaskReceipt extends JsonObject {
  readonly receiptId: string;
  readonly outcome: RightsReceiptOutcome;
  readonly resultSha256: string;
  readonly evidenceId: string;
  readonly providerOccurredAt: string;
  readonly recordedAt: string;
  readonly errorCode: string | null;
}

export interface RightsPropagationTask extends JsonObject {
  readonly taskId: string;
  readonly target: RightsPropagationTarget;
  readonly operation: Exclude<RightsRequestType, "appeal">;
  /** Server-derived B05 media reference; null for tenant-wide target classes. */
  readonly assetId: string | null;
  readonly state: RightsTaskState;
  readonly attempts: number;
  readonly receipts: RightsTaskReceipt[];
}

export interface RightsReview extends JsonObject {
  readonly reviewId: string;
  readonly reviewerActorId: string;
  readonly decision: RightsReviewDecision;
  readonly reasonCode: string;
  readonly caseReference: string;
  readonly reviewedAt: string;
}

export interface RightsRequestData extends JsonObject {
  readonly schemaVersion: typeof RIGHTS_REQUEST_SCHEMA_VERSION;
  readonly requestType: RightsRequestType;
  readonly subjectParticipantId: string;
  readonly requesterActorId: string;
  readonly requesterCapacity: RightsRequesterCapacity;
  readonly scope: RightsRequestScope & JsonObject;
  readonly policyVersion: typeof RIGHTS_WORKFLOW_POLICY_VERSION;
  /** Product enforcement deadline. Legal certification remains an external release gate. */
  readonly dueAt: string;
  readonly status: RightsRequestStatus;
  readonly parentRequestId: string | null;
  readonly correctionFields: string[];
  readonly correctionPayloadSha256: string | null;
  readonly tasks: RightsPropagationTask[];
  readonly reviews: RightsReview[];
  readonly submittedAt: string;
  readonly escalatedAt: string | null;
  readonly completedAt: string | null;
  readonly denialReasonCode: string | null;
}

export interface SubmitRightsRequestInput {
  readonly requestId?: string;
  readonly participantId: string;
  readonly requestType: RightsRequestType;
  /** "all" requests every purpose; any other value is one exact processing purpose. */
  readonly requestedProcessingPurpose: string;
  readonly correctionFields?: readonly string[];
  readonly correctionPayloadSha256?: string;
  readonly parentRequestId?: string;
  readonly idempotencyKey: string;
}

export interface RightsTaskReceiptInput {
  readonly requestId: string;
  readonly taskId: string;
  readonly outcome: RightsReceiptOutcome;
  readonly resultSha256: string;
  readonly providerOccurredAt: string;
  readonly evidenceId: string;
  readonly errorCode?: string;
  readonly idempotencyKey: string;
}

export interface ReviewRightsRequestInput {
  readonly requestId: string;
  readonly decision: RightsReviewDecision;
  readonly reasonCode: string;
  readonly caseReference: string;
  readonly idempotencyKey: string;
}

export interface EscalateRightsRequestInput {
  readonly requestId: string;
  readonly reasonCode: "sla_due" | "dependency_blocked" | "receipt_failed" | "review_disagreement";
  readonly idempotencyKey: string;
}

export interface ListRightsRequestsInput {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RightsRequestProjection {
  readonly requestId: string;
  readonly requestType: RightsRequestType;
  readonly subjectReference: string;
  readonly requestedProcessingPurpose: string;
  readonly status: RightsRequestStatus;
  readonly policyVersion: string;
  readonly submittedAt: string;
  readonly dueAt: string;
  readonly overdue: boolean;
  readonly completedAt: string | null;
  readonly parentRequestId: string | null;
  readonly progress: {
    readonly total: number;
    readonly succeeded: number;
    readonly pending: number;
    readonly blocked: number;
    readonly failed: number;
  };
  readonly tasks: readonly {
    readonly taskId: string;
    readonly target: RightsPropagationTarget;
    readonly assetReference: string | null;
    readonly state: RightsTaskState;
    readonly attempts: number;
  }[];
  readonly review: {
    readonly approvals: number;
    readonly denials: number;
    readonly requiredDistinctReviewers: 2;
  };
  readonly explanationCode:
    | "PROPAGATION_PENDING"
    | "DEPENDENCY_ATTENTION_REQUIRED"
    | "REVIEW_PENDING"
    | "SECOND_REVIEW_REQUIRED"
    | "COMPLETED"
    | "DENIED";
}

export interface RightsAuthorityDecision {
  readonly participantId: string;
  readonly requesterCapacity: RightsRequesterCapacity;
  readonly authorityExpiresAt: string;
}

export interface NormalizedRightsSubmission {
  readonly participantId: string;
  readonly requestType: RightsRequestType;
  readonly requestedProcessingPurpose: string;
  readonly correctionFields: readonly string[];
  readonly correctionPayloadSha256: string | null;
  readonly parentRequestId: string | null;
}

const SLA_HOURS: Readonly<Record<RightsRequestType, number>> = {
  access: 30 * 24,
  correction: 30 * 24,
  export: 30 * 24,
  withdraw: 24,
  delete: 30 * 24,
  restrict_processing: 24,
  appeal: 15 * 24,
};

const CORRECTION_FIELD = /^[a-z][a-z0-9_.-]{0,79}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PURPOSE = /^[a-z][a-z0-9_:-]{0,119}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

export function normalizeRightsSubmission(input: SubmitRightsRequestInput): NormalizedRightsSubmission {
  const participantId = identifier(input.participantId, "participantId");
  if (!RIGHTS_REQUEST_TYPES.includes(input.requestType)) {
    throw new DomainError("VALIDATION_FAILED", "requestType is not a supported data-subject right");
  }
  const requestedProcessingPurpose = input.requestedProcessingPurpose.trim();
  if (requestedProcessingPurpose !== "all" && !PURPOSE.test(requestedProcessingPurpose)) {
    throw new DomainError("VALIDATION_FAILED", "requestedProcessingPurpose must be all or one exact canonical purpose");
  }
  const correctionFields = [...new Set(input.correctionFields ?? [])].sort();
  if (correctionFields.length > 50 || correctionFields.some((field) => !CORRECTION_FIELD.test(field))) {
    throw new DomainError("VALIDATION_FAILED", "correctionFields must contain at most 50 canonical field names");
  }
  const correctionPayloadSha256 = input.correctionPayloadSha256 === undefined
    ? null
    : digest(input.correctionPayloadSha256, "correctionPayloadSha256");
  if (input.requestType === "correction" && (correctionFields.length === 0 || correctionPayloadSha256 === null)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "correction requests require minimized field names and a secure-payload SHA-256 binding",
    );
  }
  if (input.requestType !== "correction" && (correctionFields.length > 0 || correctionPayloadSha256 !== null)) {
    throw new DomainError("VALIDATION_FAILED", "correction details are valid only for correction requests");
  }
  const parentRequestId = input.parentRequestId === undefined ? null : identifier(input.parentRequestId, "parentRequestId");
  if ((input.requestType === "appeal") !== (parentRequestId !== null)) {
    throw new DomainError("VALIDATION_FAILED", "appeal requires exactly one prior request binding");
  }
  return {
    participantId,
    requestType: input.requestType,
    requestedProcessingPurpose,
    correctionFields,
    correctionPayloadSha256,
    parentRequestId,
  };
}

export function rightsAuthorityScope(participantIdValue: string, requestType: RightsRequestType): {
  readonly resource: string;
  readonly action: string;
} {
  const participantId = identifier(participantIdValue, "participantId");
  if (!RIGHTS_REQUEST_TYPES.includes(requestType)) throw new DomainError("VALIDATION_FAILED", "requestType is invalid");
  return { resource: `privacy.subject:${participantId}`, action: `rights.${requestType}` };
}

export function createRightsRequestData(input: {
  readonly requestId: string;
  readonly submission: NormalizedRightsSubmission;
  readonly requesterActorId: string;
  readonly requesterCapacity: RightsRequesterCapacity;
  readonly discoveredAssetIds: readonly string[];
  readonly now: string;
}): RightsRequestData {
  const requestId = identifier(input.requestId, "requestId");
  const submittedAt = timestamp(input.now, "submittedAt");
  const assetIds = [...new Set(input.discoveredAssetIds.map((assetId) => identifier(assetId, "assetId")))].sort();
  const tasks = input.submission.requestType === "appeal"
    ? []
    : propagationTasks(requestId, input.submission.requestType, assetIds);
  return {
    schemaVersion: RIGHTS_REQUEST_SCHEMA_VERSION,
    requestType: input.submission.requestType,
    subjectParticipantId: input.submission.participantId,
    requesterActorId: identifier(input.requesterActorId, "requesterActorId"),
    requesterCapacity: input.requesterCapacity,
    scope: {
      subjectResource: `privacy.subject:${input.submission.participantId}`,
      requestedProcessingPurpose: input.submission.requestedProcessingPurpose,
      action: `rights.${input.submission.requestType}`,
    },
    policyVersion: RIGHTS_WORKFLOW_POLICY_VERSION,
    dueAt: new Date(Date.parse(submittedAt) + SLA_HOURS[input.submission.requestType] * 3_600_000).toISOString(),
    status: tasks.length === 0 ? "review_pending" : "propagation_pending",
    parentRequestId: input.submission.parentRequestId,
    correctionFields: [...input.submission.correctionFields],
    correctionPayloadSha256: input.submission.correctionPayloadSha256,
    tasks,
    reviews: [],
    submittedAt,
    escalatedAt: null,
    completedAt: null,
    denialReasonCode: null,
  };
}

export function parseRightsRequestRecord(record: RecordEnvelope): RightsRequestData {
  if (record.collection !== RIGHTS_REQUEST_COLLECTION || record.deletedAt !== null ||
      record.processingPurpose !== "privacy_rights") {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "rights request record binding is invalid");
  }
  const data = record.data;
  const expected = [
    "schemaVersion", "requestType", "subjectParticipantId", "requesterActorId", "requesterCapacity", "scope",
    "policyVersion", "dueAt", "status", "parentRequestId", "correctionFields", "correctionPayloadSha256", "tasks",
    "reviews", "submittedAt", "escalatedAt", "completedAt", "denialReasonCode",
  ];
  exactKeys(data, expected, "stored rights request");
  if (data.schemaVersion !== RIGHTS_REQUEST_SCHEMA_VERSION || !RIGHTS_REQUEST_TYPES.includes(data.requestType as RightsRequestType)) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "stored rights request schema or type is invalid");
  }
  // Re-normalize all security-sensitive structure; malformed durable data fails closed.
  const candidate = data as unknown as RightsRequestData;
  identifier(candidate.subjectParticipantId, "stored subjectParticipantId");
  identifier(candidate.requesterActorId, "stored requesterActorId");
  if (record.ownerActorId === null || record.participantIds.length !== 1 ||
      record.participantIds[0] !== candidate.subjectParticipantId) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Rights request participant ownership binding is invalid");
  }
  timestamp(candidate.submittedAt, "stored submittedAt");
  timestamp(candidate.dueAt, "stored dueAt");
  if (!Array.isArray(candidate.tasks) || !Array.isArray(candidate.reviews)) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "stored rights workflow arrays are invalid");
  }
  for (const task of candidate.tasks) validateTask(task);
  for (const review of candidate.reviews) validateReview(review);
  return candidate;
}

export function rightsTaskEvidenceScope(input: {
  readonly tenantId: string;
  readonly requestId: string;
  readonly task: Pick<RightsPropagationTask, "taskId" | "target" | "operation" | "assetId">;
  readonly outcome: RightsReceiptOutcome;
  readonly resultSha256: string;
  readonly providerOccurredAt: string;
  readonly errorCode: string | null;
}): string {
  const claims = {
    tenantId: identifier(input.tenantId, "tenantId"),
    requestId: identifier(input.requestId, "requestId"),
    taskId: identifier(input.task.taskId, "taskId"),
    target: input.task.target,
    operation: input.task.operation,
    assetId: input.task.assetId,
    outcome: input.outcome,
    resultSha256: digest(input.resultSha256, "resultSha256"),
    providerOccurredAt: timestamp(input.providerOccurredAt, "providerOccurredAt"),
    errorCode: input.errorCode,
  };
  return `B04:rights-task-receipt:v1:${sha256(canonicalJson(claims))}`;
}

export function applyRightsTaskReceipt(input: {
  readonly data: RightsRequestData;
  readonly taskId: string;
  readonly outcome: RightsReceiptOutcome;
  readonly resultSha256: string;
  readonly evidenceId: string;
  readonly providerOccurredAt: string;
  readonly errorCode: string | null;
  readonly recordedAt: string;
}): { readonly data: RightsRequestData; readonly replayed: boolean } {
  if (input.data.status === "completed" || input.data.status === "denied") {
    throw new DomainError("VERSION_CONFLICT", "A terminal rights request cannot accept propagation receipts");
  }
  const taskId = identifier(input.taskId, "taskId");
  const taskIndex = input.data.tasks.findIndex((task) => task.taskId === taskId);
  if (taskIndex < 0) throw new DomainError("RESOURCE_NOT_FOUND", "Rights propagation task was not found");
  const task = input.data.tasks[taskIndex]!;
  const resultSha256 = digest(input.resultSha256, "resultSha256");
  const evidenceId = identifier(input.evidenceId, "evidenceId");
  const providerOccurredAt = timestamp(input.providerOccurredAt, "providerOccurredAt");
  const recordedAt = timestamp(input.recordedAt, "recordedAt");
  const errorCode = input.errorCode === null ? null : canonicalErrorCode(input.errorCode);
  if (input.outcome === "succeeded" && errorCode !== null) {
    throw new DomainError("VALIDATION_FAILED", "Successful rights receipts cannot contain an errorCode");
  }
  if (input.outcome !== "succeeded" && errorCode === null) {
    throw new DomainError("VALIDATION_FAILED", "Blocked or failed rights receipts require a closed errorCode");
  }
  const receiptId = `rights-receipt:${sha256(canonicalJson({ taskId, evidenceId, resultSha256, input: input.outcome }))}`;
  const existing = task.receipts.find((receipt) => receipt.receiptId === receiptId || receipt.evidenceId === evidenceId);
  if (existing !== undefined) {
    if (existing.outcome !== input.outcome || existing.resultSha256 !== resultSha256 ||
        existing.providerOccurredAt !== providerOccurredAt || existing.errorCode !== errorCode) {
      throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Rights task evidence was rebound to different receipt facts");
    }
    return { data: input.data, replayed: true };
  }
  if (task.state === "succeeded") {
    throw new DomainError("VERSION_CONFLICT", "A succeeded propagation task cannot be overwritten");
  }
  const receipt: RightsTaskReceipt = {
    receiptId,
    outcome: input.outcome,
    resultSha256,
    evidenceId,
    providerOccurredAt,
    recordedAt,
    errorCode,
  };
  const nextTask: RightsPropagationTask = {
    ...task,
    state: input.outcome,
    attempts: task.attempts + 1,
    receipts: [...task.receipts, receipt],
  };
  const tasks = input.data.tasks.map((entry, index) => index === taskIndex ? nextTask : entry);
  const allSucceeded = tasks.every((entry) => entry.state === "succeeded");
  const needsEscalation = tasks.some((entry) => entry.state === "failed") || Date.parse(input.data.dueAt) <= Date.parse(recordedAt);
  return {
    replayed: false,
    data: {
      ...input.data,
      tasks,
      status: allSucceeded ? "review_pending" : needsEscalation ? "escalated" : "propagation_pending",
      escalatedAt: needsEscalation ? (input.data.escalatedAt ?? recordedAt) : input.data.escalatedAt,
    },
  };
}

export function applyRightsReview(input: {
  readonly data: RightsRequestData;
  readonly reviewerActorId: string;
  readonly decision: RightsReviewDecision;
  readonly reasonCode: string;
  readonly caseReference: string;
  readonly reviewId: string;
  readonly reviewedAt: string;
}): { readonly data: RightsRequestData; readonly replayed: boolean } {
  if (input.data.status === "completed" || input.data.status === "denied") {
    throw new DomainError("VERSION_CONFLICT", "A terminal rights request cannot be reviewed again; submit an appeal");
  }
  if (input.data.tasks.some((task) => task.state !== "succeeded")) {
    throw new DomainError("VERSION_CONFLICT", "All closed propagation targets require successful receipts before review");
  }
  const reviewerActorId = identifier(input.reviewerActorId, "reviewerActorId");
  const reviewId = identifier(input.reviewId, "reviewId");
  const reasonCode = canonicalErrorCode(input.reasonCode);
  const caseReference = identifier(input.caseReference, "caseReference");
  const reviewedAt = timestamp(input.reviewedAt, "reviewedAt");
  const existing = input.data.reviews.find((review) => review.reviewId === reviewId);
  if (existing !== undefined) {
    if (existing.reviewerActorId !== reviewerActorId || existing.decision !== input.decision ||
        existing.reasonCode !== reasonCode || existing.caseReference !== caseReference) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Review id was rebound to different decision facts");
    }
    return { data: input.data, replayed: true };
  }
  if (input.data.reviews.some((review) => review.reviewerActorId === reviewerActorId)) {
    throw new DomainError("AUTH_FORBIDDEN", "Two-person review requires a distinct second reviewer");
  }
  const reviews = [...input.data.reviews, { reviewId, reviewerActorId, decision: input.decision, reasonCode, caseReference, reviewedAt }];
  if (reviews.length > 2) throw new DomainError("VERSION_CONFLICT", "Rights workflow already has two review decisions");
  const status: RightsRequestStatus = reviews.length === 1
    ? "awaiting_second_review"
    : reviews[0]!.decision !== reviews[1]!.decision
      ? "escalated"
      : input.decision === "approve" ? "completed" : "denied";
  return {
    replayed: false,
    data: {
      ...input.data,
      reviews,
      status,
      escalatedAt: status === "escalated" ? (input.data.escalatedAt ?? reviewedAt) : input.data.escalatedAt,
      completedAt: status === "completed" ? reviewedAt : null,
      denialReasonCode: status === "denied" ? reasonCode : null,
    },
  };
}

export function escalateRightsRequestData(
  data: RightsRequestData,
  atValue: string,
): RightsRequestData {
  if (data.status === "completed" || data.status === "denied") return data;
  const at = timestamp(atValue, "escalatedAt");
  return { ...data, status: "escalated", escalatedAt: data.escalatedAt ?? at };
}

export function projectRightsRequest(record: RecordEnvelope, context: ActorContext, now = new Date()): RightsRequestProjection {
  if (record.tenantId !== context.tenantId) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "Rights request is outside the authenticated tenant");
  }
  const data = parseRightsRequestRecord(record);
  const counts = {
    total: data.tasks.length,
    succeeded: data.tasks.filter((task) => task.state === "succeeded").length,
    pending: data.tasks.filter((task) => task.state === "pending").length,
    blocked: data.tasks.filter((task) => task.state === "blocked").length,
    failed: data.tasks.filter((task) => task.state === "failed").length,
  };
  const overdue = !["completed", "denied"].includes(data.status) && Date.parse(data.dueAt) <= now.getTime();
  const explanationCode = data.status === "completed" ? "COMPLETED"
    : data.status === "denied" ? "DENIED"
      : data.status === "awaiting_second_review" ? "SECOND_REVIEW_REQUIRED"
        : data.status === "review_pending" ? "REVIEW_PENDING"
          : data.status === "escalated" || overdue || counts.failed > 0 ? "DEPENDENCY_ATTENTION_REQUIRED"
            : "PROPAGATION_PENDING";
  return {
    requestId: record.id,
    requestType: data.requestType,
    subjectReference: `subject_${sha256(`${record.tenantId}\n${data.subjectParticipantId}`).slice(0, 16)}`,
    requestedProcessingPurpose: data.scope.requestedProcessingPurpose,
    status: overdue && !["completed", "denied", "escalated"].includes(data.status) ? "escalated" : data.status,
    policyVersion: data.policyVersion,
    submittedAt: data.submittedAt,
    dueAt: data.dueAt,
    overdue,
    completedAt: data.completedAt,
    parentRequestId: data.parentRequestId,
    progress: counts,
    tasks: data.tasks.map((task) => ({
      taskId: task.taskId,
      target: task.target,
      assetReference: task.assetId === null ? null : `asset_${sha256(`${record.tenantId}\n${task.assetId}`).slice(0, 16)}`,
      state: task.state,
      attempts: task.attempts,
    })),
    review: {
      approvals: data.reviews.filter((review) => review.decision === "approve").length,
      denials: data.reviews.filter((review) => review.decision === "deny").length,
      requiredDistinctReviewers: 2,
    },
    explanationCode,
  };
}

export function canReadRightsRequest(record: RecordEnvelope, context: ActorContext): boolean {
  const data = parseRightsRequestRecord(record);
  return record.tenantId === context.tenantId &&
    (data.requesterActorId === context.actorId || context.roles.includes("privacy_officer") ||
      context.roles.includes("platform_admin") || context.permissions?.includes("rights-request:read:any") === true);
}

function propagationTasks(
  requestId: string,
  operation: Exclude<RightsRequestType, "appeal">,
  assetIds: readonly string[],
): RightsPropagationTask[] {
  const tasks: RightsPropagationTask[] = [];
  for (const target of RIGHTS_PROPAGATION_TARGETS) {
    if ((target === "object_storage" || target === "derived_artifacts") && assetIds.length > 0) {
      for (const assetId of assetIds) tasks.push(task(requestId, target, operation, assetId));
    } else {
      tasks.push(task(requestId, target, operation, null));
    }
  }
  return tasks;
}

function task(
  requestId: string,
  target: RightsPropagationTarget,
  operation: Exclude<RightsRequestType, "appeal">,
  assetId: string | null,
): RightsPropagationTask {
  return {
    taskId: `rights-task:${sha256(canonicalJson({ requestId, target, operation, assetId }))}`,
    target,
    operation,
    assetId,
    state: "pending",
    attempts: 0,
    receipts: [],
  };
}

function validateTask(taskValue: RightsPropagationTask): void {
  const taskObject = taskValue as unknown as JsonObject;
  exactKeys(taskObject, ["taskId", "target", "operation", "assetId", "state", "attempts", "receipts"], "stored rights task");
  identifier(taskValue.taskId, "stored taskId");
  if (!RIGHTS_PROPAGATION_TARGETS.includes(taskValue.target) || !RIGHTS_REQUEST_TYPES.includes(taskValue.operation) ||
      !["pending", "succeeded", "blocked", "failed"].includes(taskValue.state) ||
      !Number.isSafeInteger(taskValue.attempts) || taskValue.attempts < 0 || !Array.isArray(taskValue.receipts)) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "stored rights task is invalid");
  }
  if (taskValue.assetId !== null) identifier(taskValue.assetId, "stored task assetId");
  for (const receipt of taskValue.receipts) {
    exactKeys(receipt as unknown as JsonObject, [
      "receiptId", "outcome", "resultSha256", "evidenceId", "providerOccurredAt", "recordedAt", "errorCode",
    ], "stored rights receipt");
    identifier(receipt.receiptId, "stored receiptId");
    digest(receipt.resultSha256, "stored resultSha256");
    identifier(receipt.evidenceId, "stored evidenceId");
    timestamp(receipt.providerOccurredAt, "stored providerOccurredAt");
    timestamp(receipt.recordedAt, "stored recordedAt");
  }
}

function validateReview(review: RightsReview): void {
  exactKeys(review as unknown as JsonObject, [
    "reviewId", "reviewerActorId", "decision", "reasonCode", "caseReference", "reviewedAt",
  ], "stored rights review");
  identifier(review.reviewId, "stored reviewId");
  identifier(review.reviewerActorId, "stored reviewerActorId");
  if (review.decision !== "approve" && review.decision !== "deny") {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "stored rights review decision is invalid");
  }
  canonicalErrorCode(review.reasonCode);
  identifier(review.caseReference, "stored caseReference");
  timestamp(review.reviewedAt, "stored reviewedAt");
}

function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a canonical identifier`);
  }
  return value;
}

function digest(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function timestamp(value: string, label: string): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_FAILED", `${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function canonicalErrorCode(value: string): string {
  if (typeof value !== "string" || !ERROR_CODE.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "reason/error code must be a closed uppercase code");
  }
  return value;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", `${label} contains an unknown or missing field`);
  }
}
