import { randomUUID } from "node:crypto";

const baseUrl = (process.env.LTM_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const token = process.env.LTM_SMOKE_TOKEN ?? "local-platform-admin";
const purpose = process.env.LTM_SMOKE_PURPOSE ?? "platform_architecture";
const runId = randomUUID();

const health = await request("/health/ready");
assert(health.ready === true, "readiness did not report ready");

const catalog = await request("/v1/capabilities");
assert(catalog.count === 128 && catalog.capabilities?.length === 128, "capability catalog is not B00-B127 complete");

const architectureInput = {
  repositoryId: `smoke-${runId}`,
  stackProfile: "all-typescript",
  boundedContexts: ["identity", "generation"],
  healthChecks: ["liveness", "readiness"],
  ownershipRules: ["tenant-scoped"],
};
const architectureKey = `smoke-architecture-${runId}`;
const architecture = await command("B01", architectureInput, architectureKey);
assert(
  architecture.data?.state === "persisted" &&
    typeof architecture.data?.recordId === "string" &&
    architecture.data?.replayed === false,
  "architecture resource was not durably persisted",
);
const replay = await command("B01", architectureInput, architectureKey);
assert(
  replay.data?.recordId === architecture.data?.recordId && replay.data?.replayed === true,
  "architecture replay was not idempotent",
);
const storedArchitecture = await query("record.get", {
  collection: "platform.architectures",
  id: architecture.data.recordId,
});
assert(
  storedArchitecture.data?.data?.repositoryId === architectureInput.repositoryId &&
    storedArchitecture.data?.data?.stackProfile === "all-typescript",
  "architecture resource was not queryable",
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

process.stdout.write(`PASS smoke health=ready capabilities=128 architecture=${architecture.data.recordId} persisted=true replay=true identity_injection=rejected\n`);

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
    "x-purpose": purpose,
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
