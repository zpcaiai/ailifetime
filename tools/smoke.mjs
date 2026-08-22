import { createHash, randomUUID } from "node:crypto";

const baseUrl = (process.env.LTM_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const token = process.env.LTM_SMOKE_TOKEN ?? "local-consumer";
const runId = randomUUID();
const actorId = "user-synthetic";

const health = await request("/health/ready");
assert(health.ready === true, "readiness did not report ready");

const catalog = await request("/v1/capabilities");
assert(catalog.count === 128 && catalog.capabilities?.length === 128, "capability catalog is not B00-B127 complete");

const evidenceHash = createHash("sha256")
  .update(`tenant-local:${actorId}:${runId}:age_transformation`)
  .digest("hex");
const consentInput = {
  participantId: actorId,
  purpose: "age_transformation",
  policyVersion: "local-synthetic-v1",
  evidenceHash,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  status: "active",
  isMinor: false,
};
const consent = await command("B04", consentInput, `smoke-consent-${runId}`);
assert(consent.data?.state === "active", "consent was not activated");

const timelineInput = {
  jobId: `job-${runId}`,
  sourceAssetId: "asset-synthetic-portrait",
  participantIds: [actorId],
  targetAges: [18, 35, 55, 75, 100],
  seed: runId,
  promptPolicyVersion: "illustrative-v1",
  illustrativeLabel: true,
};
const timelineKey = `smoke-timeline-${runId}`;
const timeline = await command("B14", timelineInput, timelineKey);
assert(
  timeline.data?.state === "requested" &&
    timeline.data?.commandState === "requested" &&
    timeline.data?.externalCommandId === timeline.data?.recordId &&
    timeline.data?.replayed === false,
  "timeline command was not durably staged",
);
const replay = await command("B14", timelineInput, timelineKey);
assert(replay.data?.recordId === timeline.data?.recordId && replay.data?.replayed === true, "timeline replay was not idempotent");
const stagedCommand = await query("record.get", {
  collection: "generation.timeline-commands",
  id: timeline.data.recordId,
});
assert(
  stagedCommand.data?.data?.commandState === "requested" &&
    stagedCommand.data?.data?.externalCommandId === timeline.data?.externalCommandId,
  "timeline command record was not queryable",
);

const injection = await fetch(`${baseUrl}/v1/queries`, {
  method: "POST",
  headers: {
    ...authHeaders(),
    "content-type": "application/json",
    "x-tenant-id": "attacker-tenant",
  },
  body: JSON.stringify({ query: "record.list", input: { collection: "projects" } }),
  signal: AbortSignal.timeout(5_000),
});
assert(injection.status === 403, "client-asserted tenant context was not rejected");

process.stdout.write(`PASS smoke health=ready capabilities=128 consent=active timeline=${timeline.data.recordId} command=requested replay=true identity_injection=rejected\n`);

async function command(batchId, input, idempotencyKey) {
  return request(`/v1/capabilities/${batchId}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(input),
  });
}

async function query(operation, input) {
  return request("/v1/queries", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: operation, input }),
  });
}

function authHeaders() {
  return {
    authorization: `Bearer ${token}`,
    "x-purpose": "age_transformation",
  };
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${body.error?.code ?? "HTTP_ERROR"} ${body.error?.message ?? ""}`.trim());
  }
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
