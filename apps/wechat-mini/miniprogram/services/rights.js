const api = require("./api");

const REQUEST_TYPES = new Set([
  "access", "correction", "export", "withdraw", "delete", "restrict_processing", "appeal",
]);

async function submit(input) {
  const participantId = identifier(input && input.participantId, "PARTICIPANT_ID_INVALID");
  const requestType = input && input.requestType;
  if (!REQUEST_TYPES.has(requestType)) throw new Error("RIGHTS_REQUEST_TYPE_INVALID");
  const requestedProcessingPurpose = typeof input.requestedProcessingPurpose === "string"
    ? input.requestedProcessingPurpose.trim() : "";
  if (requestedProcessingPurpose !== "all" && !/^[a-z][a-z0-9_:-]{0,119}$/.test(requestedProcessingPurpose)) {
    throw new Error("RIGHTS_PURPOSE_INVALID");
  }
  const requestId = api.idempotencyKey("rights");
  const payload = { requestId, participantId, requestType, requestedProcessingPurpose };
  if (requestType === "correction") {
    const correctionFields = [...new Set((input.correctionFields || []).map((value) => String(value).trim())
      .filter((value) => value !== ""))];
    const correctionPayloadSha256 = typeof input.correctionPayloadSha256 === "string"
      ? input.correctionPayloadSha256.trim().toLowerCase() : "";
    if (correctionFields.length < 1 || correctionFields.length > 50 ||
        correctionFields.some((field) => !/^[a-z][a-z0-9_.-]{0,79}$/.test(field)) ||
        !/^[a-f0-9]{64}$/.test(correctionPayloadSha256)) throw new Error("RIGHTS_CORRECTION_BINDING_INVALID");
    payload.correctionFields = correctionFields;
    payload.correctionPayloadSha256 = correctionPayloadSha256;
  }
  if (requestType === "appeal") payload.parentRequestId = identifier(input.parentRequestId, "RIGHTS_PARENT_INVALID");
  const envelope = await api.requestForPurpose("/v1/commands", "privacy_rights", {
    data: { command: "rights-request.submit", input: payload },
    headers: { "Idempotency-Key": requestId },
  });
  const data = objectValue(envelope && envelope.data, "RIGHTS_RESPONSE_INVALID");
  return project(Object.prototype.hasOwnProperty.call(data, "value") ? data.value : data);
}

async function list(limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("RIGHTS_LIMIT_INVALID");
  const envelope = await api.requestForPurpose("/v1/queries", "privacy_rights", {
    data: { query: "rights-request.list", input: { limit } },
  });
  if (!envelope || !Array.isArray(envelope.data)) throw new Error("RIGHTS_RESPONSE_INVALID");
  return envelope.data.map(project);
}

function project(value) {
  const source = objectValue(value, "RIGHTS_PROJECTION_INVALID");
  const requestId = identifier(source.requestId, "RIGHTS_PROJECTION_INVALID");
  if (!REQUEST_TYPES.has(source.requestType) || typeof source.status !== "string" ||
      typeof source.subjectReference !== "string" || !/^subject_[a-f0-9]{16}$/.test(source.subjectReference) ||
      !Array.isArray(source.tasks)) throw new Error("RIGHTS_PROJECTION_INVALID");
  return {
    requestId,
    requestType: source.requestType,
    subjectReference: source.subjectReference,
    requestedProcessingPurpose: source.requestedProcessingPurpose,
    status: source.status,
    submittedAt: source.submittedAt,
    dueAt: source.dueAt,
    overdue: source.overdue === true,
    completedAt: source.completedAt || null,
    parentRequestId: source.parentRequestId || null,
    progress: closedProgress(source.progress),
    tasks: source.tasks.map((raw) => {
      const task = objectValue(raw, "RIGHTS_PROJECTION_INVALID");
      return {
        taskId: identifier(task.taskId, "RIGHTS_PROJECTION_INVALID"),
        target: typeof task.target === "string" ? task.target : invalidProjection(),
        assetReference: task.assetReference === null ||
          (typeof task.assetReference === "string" && /^asset_[a-f0-9]{16}$/.test(task.assetReference))
          ? task.assetReference : invalidProjection(),
        state: typeof task.state === "string" ? task.state : invalidProjection(),
        attempts: Number.isInteger(task.attempts) && task.attempts >= 0 ? task.attempts : invalidProjection(),
      };
    }),
    review: closedReview(source.review),
    explanationCode: typeof source.explanationCode === "string" ? source.explanationCode : invalidProjection(),
  };
}

function closedProgress(value) {
  const progress = objectValue(value, "RIGHTS_PROJECTION_INVALID");
  return {
    total: integer(progress.total),
    succeeded: integer(progress.succeeded),
    pending: integer(progress.pending),
    blocked: integer(progress.blocked),
    failed: integer(progress.failed),
  };
}

function closedReview(value) {
  const review = objectValue(value, "RIGHTS_PROJECTION_INVALID");
  return {
    approvals: integer(review.approvals),
    denials: integer(review.denials),
    requiredDistinctReviewers: review.requiredDistinctReviewers === 2 ? 2 : invalidProjection(),
  };
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : invalidProjection();
}

function identifier(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(code);
  return value;
}

function objectValue(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

function invalidProjection() { throw new Error("RIGHTS_PROJECTION_INVALID"); }

module.exports = { REQUEST_TYPES, submit, list, project };
