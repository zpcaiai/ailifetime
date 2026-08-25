import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRightsReview,
  applyRightsTaskReceipt,
  createRightsRequestData,
  normalizeRightsSubmission,
  projectRightsRequest,
  RIGHTS_REQUEST_COLLECTION,
  RIGHTS_REQUEST_TYPES,
  rightsTaskEvidenceScope,
} from "../dist/index.js";

const NOW = "2026-08-24T08:00:00.000Z";

function submission(overrides = {}) {
  return normalizeRightsSubmission({
    participantId: "participant-rights-1",
    requestType: "delete",
    requestedProcessingPurpose: "all",
    idempotencyKey: "submit-rights-1",
    ...overrides,
  });
}

function data(overrides = {}) {
  return createRightsRequestData({
    requestId: "rights-request-1",
    submission: submission(overrides),
    requesterActorId: "consumer-rights-1",
    requesterCapacity: "self",
    discoveredAssetIds: ["asset-rights-2", "asset-rights-1"],
    now: NOW,
  });
}

function record(value) {
  return {
    id: "rights-request-1",
    tenantId: "tenant-rights-1",
    collection: RIGHTS_REQUEST_COLLECTION,
    processingPurpose: "privacy_rights",
    ownerActorId: "consumer-rights-1",
    participantIds: ["participant-rights-1"],
    containsMinor: false,
    data: value,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

test("rights workflow covers all seven closed request types and derives a closed target inventory", () => {
  for (const requestType of RIGHTS_REQUEST_TYPES) {
    const normalized = submission(requestType === "correction"
      ? { requestType, correctionFields: ["profile.display_name"], correctionPayloadSha256: "a".repeat(64) }
      : requestType === "appeal"
        ? { requestType, parentRequestId: "rights-prior-1" }
        : { requestType });
    const created = createRightsRequestData({
      requestId: `rights-${requestType.replace("_", "-")}`,
      submission: normalized,
      requesterActorId: "consumer-rights-1",
      requesterCapacity: "self",
      discoveredAssetIds: ["asset-rights-1"],
      now: NOW,
    });
    assert.equal(created.requestType, requestType);
    assert.equal(created.status, requestType === "appeal" ? "review_pending" : "propagation_pending");
    assert.equal(created.tasks.length, requestType === "appeal" ? 0 : 8);
  }
  const created = data();
  assert.equal(created.tasks.length, 10);
  assert.deepEqual(
    created.tasks.filter((task) => task.target === "object_storage").map((task) => task.assetId),
    ["asset-rights-1", "asset-rights-2"],
  );
  assert.deepEqual(
    created.tasks.filter((task) => task.target === "derived_artifacts").map((task) => task.assetId),
    ["asset-rights-1", "asset-rights-2"],
  );
});

test("closed receipts cannot complete a request before every target and two distinct reviewers approve", () => {
  let current = data();
  current.tasks.forEach((task, index) => {
    const providerOccurredAt = new Date(Date.parse(NOW) + index * 1_000).toISOString();
    const resultSha256 = index.toString(16).padStart(64, "0");
    const evidenceId = `rights-evidence-${String(index).padStart(2, "0")}`;
    assert.match(rightsTaskEvidenceScope({
      tenantId: "tenant-rights-1",
      requestId: "rights-request-1",
      task,
      outcome: "succeeded",
      resultSha256,
      providerOccurredAt,
      errorCode: null,
    }), /^B04:rights-task-receipt:v1:[a-f0-9]{64}$/);
    current = applyRightsTaskReceipt({
      data: current,
      taskId: task.taskId,
      outcome: "succeeded",
      resultSha256,
      evidenceId,
      providerOccurredAt,
      errorCode: null,
      recordedAt: providerOccurredAt,
    }).data;
    assert.notEqual(current.status, "completed");
  });
  assert.equal(current.status, "review_pending");
  const first = applyRightsReview({
    data: current,
    reviewerActorId: "privacy-reviewer-1",
    decision: "approve",
    reasonCode: "VERIFIED_COMPLETE",
    caseReference: "privacy-case-1",
    reviewId: "rights-review-1",
    reviewedAt: "2026-08-24T09:00:00.000Z",
  }).data;
  assert.equal(first.status, "awaiting_second_review");
  assert.throws(() => applyRightsReview({
    data: first,
    reviewerActorId: "privacy-reviewer-1",
    decision: "approve",
    reasonCode: "VERIFIED_COMPLETE",
    caseReference: "privacy-case-1",
    reviewId: "rights-review-2",
    reviewedAt: "2026-08-24T09:01:00.000Z",
  }), (error) => error?.code === "AUTH_FORBIDDEN");
  const second = applyRightsReview({
    data: first,
    reviewerActorId: "privacy-reviewer-2",
    decision: "approve",
    reasonCode: "VERIFIED_COMPLETE",
    caseReference: "privacy-case-1",
    reviewId: "rights-review-2",
    reviewedAt: "2026-08-24T09:02:00.000Z",
  }).data;
  assert.equal(second.status, "completed");
});

test("failed propagation escalates and the support projection redacts subjects, assets, evidence and digests", () => {
  const original = data();
  const task = original.tasks[0];
  const failed = applyRightsTaskReceipt({
    data: original,
    taskId: task.taskId,
    outcome: "failed",
    resultSha256: "f".repeat(64),
    evidenceId: "rights-evidence-failed-1",
    providerOccurredAt: "2026-08-24T08:05:00.000Z",
    errorCode: "DEPENDENCY_UNAVAILABLE",
    recordedAt: "2026-08-24T08:05:01.000Z",
  }).data;
  assert.equal(failed.status, "escalated");
  assert.throws(() => applyRightsReview({
    data: failed,
    reviewerActorId: "privacy-reviewer-1",
    decision: "approve",
    reasonCode: "VERIFIED_COMPLETE",
    caseReference: "privacy-case-1",
    reviewId: "rights-review-1",
    reviewedAt: "2026-08-24T09:00:00.000Z",
  }), (error) => error?.code === "VERSION_CONFLICT");
  const projection = projectRightsRequest(record(failed), {
    actorId: "support-1",
    tenantId: "tenant-rights-1",
    roles: ["support_agent"],
    purpose: "privacy_rights",
    requestId: "rights-support-view",
  }, new Date("2026-08-24T08:06:00.000Z"));
  const serialized = JSON.stringify(projection);
  assert.equal(projection.explanationCode, "DEPENDENCY_ATTENTION_REQUIRED");
  assert.match(projection.subjectReference, /^subject_[a-f0-9]{16}$/);
  assert.doesNotMatch(serialized, /participant-rights-1|asset-rights-1|rights-evidence|[af]{64}/);
});

test("appeals require an exact prior request and remain subject to two-person review", () => {
  assert.throws(() => submission({ requestType: "appeal" }), (error) => error?.code === "VALIDATION_FAILED");
  const appeal = createRightsRequestData({
    requestId: "rights-appeal-1",
    submission: submission({ requestType: "appeal", parentRequestId: "rights-denied-1" }),
    requesterActorId: "consumer-rights-1",
    requesterCapacity: "self",
    discoveredAssetIds: [],
    now: NOW,
  });
  assert.equal(appeal.tasks.length, 0);
  assert.equal(appeal.status, "review_pending");
  const split = applyRightsReview({
    data: applyRightsReview({
      data: appeal,
      reviewerActorId: "privacy-reviewer-1",
      decision: "approve",
      reasonCode: "APPEAL_UPHELD",
      caseReference: "privacy-appeal-case-1",
      reviewId: "appeal-review-1",
      reviewedAt: "2026-08-24T09:00:00.000Z",
    }).data,
    reviewerActorId: "privacy-reviewer-2",
    decision: "deny",
    reasonCode: "APPEAL_DENIED",
    caseReference: "privacy-appeal-case-1",
    reviewId: "appeal-review-2",
    reviewedAt: "2026-08-24T09:01:00.000Z",
  }).data;
  assert.equal(split.status, "escalated");
});
