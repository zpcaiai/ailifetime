import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import {
  LifeTimeMachineApiError,
  LifeTimeMachineClient,
  LifeTimeMachineTransportError,
} from "./index.js";

const session = { accessToken: "synthetic-access-token", purpose: "product_operation" } as const;

test("real HTTP contract sends exact envelopes and consistently unwraps data", async () => {
  const requests: Array<{ path: string; headers: IncomingMessage["headers"]; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ path: request.url ?? "", headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/capabilities/B14") {
      response.setHeader("x-request-id", "req-execute");
      response.end(JSON.stringify({ data: { id: "timeline-1" }, meta: { requestId: "req-execute", batchId: "B14" } }));
    } else if (request.url === "/v1/commands") {
      response.end(JSON.stringify({ data: { id: "record-1" }, meta: { requestId: "req-command", command: "record.create" } }));
    } else {
      response.end(JSON.stringify({ data: [{ id: "record-1" }], meta: { requestId: "req-query", query: "record.list" } }));
    }
  });
  const baseUrl = await listen(server);
  try {
    const client = new LifeTimeMachineClient({ baseUrl, session });
    assert.deepEqual(await client.execute("B14", { targetAges: [25, 50] }, "idem-execute-1"), { id: "timeline-1" });
    assert.deepEqual(await client.command("record.create", { collection: "projects", data: {} }, "idem-command-1"), { id: "record-1" });
    const envelope = await client.queryEnvelope<readonly { id: string }[]>("record.list", { collection: "projects" });
    assert.deepEqual(envelope.data, [{ id: "record-1" }]);
    assert.equal(envelope.meta.requestId, "req-query");

    assert.deepEqual(requests.map((request) => request.path), ["/v1/capabilities/B14", "/v1/commands", "/v1/queries"]);
    assert.deepEqual(requests[0]?.body, { targetAges: [25, 50] });
    assert.deepEqual(requests[1]?.body, { command: "record.create", input: { collection: "projects", data: {} } });
    assert.deepEqual(requests[2]?.body, { query: "record.list", input: { collection: "projects" } });
    for (const request of requests) {
      assert.equal(request.headers.authorization, "Bearer synthetic-access-token");
      assert.equal(request.headers["x-purpose"], "product_operation");
      assert.equal(request.headers["x-tenant-id"], undefined);
      assert.equal(request.headers["x-actor-id"], undefined);
      assert.equal(request.headers["x-actor-role"], undefined);
      assert.equal(request.headers["x-permissions"], undefined);
    }
    assert.equal(requests[0]?.headers["idempotency-key"], "idem-execute-1");
    assert.equal(requests[1]?.headers["idempotency-key"], "idem-command-1");
    assert.equal(requests[2]?.headers["idempotency-key"], undefined);
  } finally {
    await close(server);
  }
});

test("base URL rejects credential leakage and cleartext non-loopback origins", () => {
  for (const baseUrl of [
    "http://example.com",
    "http://10.0.0.1:8080",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "https://example.com?",
    "https://example.com#fragment",
    "https://example.com#",
    "https://example.com/api",
  ]) {
    assert.throws(() => new LifeTimeMachineClient({ baseUrl, session }), /baseUrl|HTTP/);
  }
  assert.doesNotThrow(() => new LifeTimeMachineClient({ baseUrl: "http://127.9.8.7:8080", session }));
  assert.doesNotThrow(() => new LifeTimeMachineClient({ baseUrl: "http://[::1]:8080", session }));
  assert.doesNotThrow(() => new LifeTimeMachineClient({ baseUrl: "https://api.example.com", session }));
});

test("200 malformed dispatch envelopes and oversized bodies fail closed", async () => {
  const malformed = new LifeTimeMachineClient({
    baseUrl: "http://127.0.0.1:8080",
    session,
    maxRetries: 0,
    fetch: async () => Response.json({ id: "not-an-envelope" }),
  });
  await assert.rejects(
    malformed.execute("B14", {}, "idem-malformed-1"),
    (error: unknown) => error instanceof LifeTimeMachineApiError && error.code === "INVALID_RESPONSE" && error.status === 502,
  );

  const oversized = new LifeTimeMachineClient({
    baseUrl: "http://127.0.0.1:8080",
    session,
    maxRetries: 0,
    maxResponseBytes: 32,
    fetch: async () => new Response(JSON.stringify({ data: "x".repeat(100), meta: { requestId: "req-large", batchId: "B14" } })),
  });
  await assert.rejects(
    oversized.execute("B14", {}, "idem-large-1"),
    (error: unknown) => error instanceof LifeTimeMachineApiError && error.code === "INVALID_RESPONSE",
  );
});

test("structured errors preserve the exact stable error envelope", async () => {
  const client = new LifeTimeMachineClient({
    baseUrl: "http://127.0.0.1:8080",
    session,
    maxRetries: 0,
    fetch: async () => Response.json({
      error: { code: "CONSENT_REQUIRED", message: "consent missing", retryable: false, details: { participantId: "p-1" } },
      requestId: "req-error-1",
    }, { status: 403, headers: { "x-request-id": "req-error-1" } }),
  });
  await assert.rejects(client.command("record.create", {}, "idem-error-1"), (error: unknown) => {
    assert.ok(error instanceof LifeTimeMachineApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "CONSENT_REQUIRED");
    assert.equal(error.requestId, "req-error-1");
    assert.deepEqual(error.details, { participantId: "p-1" });
    return true;
  });
});

test("429 Retry-After is capped and retries preserve the idempotency key", async () => {
  const idempotencyKeys: string[] = [];
  let attempts = 0;
  const started = Date.now();
  const client = new LifeTimeMachineClient({
    baseUrl: "http://127.0.0.1:8080",
    session,
    maxRetries: 1,
    maxRetryDelayMs: 2,
    fetch: async (_input, init) => {
      attempts += 1;
      idempotencyKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (attempts === 1) {
        return Response.json({
          error: { code: "RATE_LIMITED", message: "try later", retryable: true, details: {} },
          requestId: "req-rate-1",
        }, { status: 429, headers: { "retry-after": "3600" } });
      }
      return Response.json({ data: { id: "record-2" }, meta: { requestId: "req-rate-2", command: "record.create" } });
    },
  });
  assert.deepEqual(await client.command("record.create", {}, "idem-retry-1"), { id: "record-2" });
  assert.equal(attempts, 2);
  assert.deepEqual(idempotencyKeys, ["idem-retry-1", "idem-retry-1"]);
  assert.ok(Date.now() - started < 500, "Retry-After must be capped by maxRetryDelayMs");
});

test("timeouts and I/O failures are typed and bounded", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end(JSON.stringify({ data: {}, meta: { requestId: "late", query: "record.list" } })), 100);
  });
  const baseUrl = await listen(server);
  try {
    const timeoutClient = new LifeTimeMachineClient({ baseUrl, session, timeoutMs: 10, maxRetries: 0 });
    await assert.rejects(
      timeoutClient.query("record.list", {}),
      (error: unknown) => error instanceof LifeTimeMachineTransportError && error.code === "REQUEST_TIMEOUT",
    );
  } finally {
    await close(server);
  }

  let attempts = 0;
  const ioClient = new LifeTimeMachineClient({
    baseUrl: "http://127.0.0.1:8080",
    session,
    maxRetries: 1,
    maxRetryDelayMs: 0,
    fetch: async () => {
      attempts += 1;
      throw new TypeError("connection reset");
    },
  });
  await assert.rejects(
    ioClient.query("record.list"),
    (error: unknown) => error instanceof LifeTimeMachineTransportError && error.code === "NETWORK_ERROR",
  );
  assert.equal(attempts, 2);
});

test("non-idempotent dispatch cannot reach the network without a valid key", async () => {
  let attempts = 0;
  const client = new LifeTimeMachineClient({
    baseUrl: "http://127.0.0.1:8080",
    session,
    fetch: async () => {
      attempts += 1;
      return Response.json({});
    },
  });
  await assert.rejects(client.command("record.create", {}, ""), /idempotency key/);
  await assert.rejects(client.execute("B14", {}, "x".repeat(201)), /idempotency key/);
  assert.equal(attempts, 0);
});

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
