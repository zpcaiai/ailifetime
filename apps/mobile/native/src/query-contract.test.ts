import assert from "node:assert/strict";
import test from "node:test";
import { parseGenerationJob, parseLibraryRecords } from "./query-contract";

const job = {
  id: "job-1",
  collection: "generation.timeline-commands",
  data: { batchId: "B14", operation: "createTimeline", jobId: "job-1", commandState: "requested", illustrativeLabel: true },
};

test("generic record projections are narrowed to B14 mobile library and job views", () => {
  assert.deepEqual(parseLibraryRecords([job]), [{ id: "job-1", state: "requested", aiLabel: "AI 生成艺术内容" }]);
  assert.deepEqual(parseGenerationJob(job, "job-1"), { state: "requested" });
});

test("job projection rejects cross-record and unlabeled data", () => {
  assert.throws(() => parseGenerationJob({ ...job, id: "job-2" }, "job-1"), /GENERATION_JOB_RESPONSE_INVALID/);
  assert.throws(() => parseLibraryRecords([{ ...job, data: { ...job.data, illustrativeLabel: false } }]), /MOBILE_LIBRARY_RESPONSE_INVALID/);
});
