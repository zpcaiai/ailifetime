import assert from "node:assert/strict";
import test from "node:test";
import { LifeTimeMachineApiError, LifeTimeMachineClient } from "./index.js";

const session = { accessToken: "synthetic-access-token", purpose: "product" } as const;

test("client sends bearer authorization, purpose, and idempotency without asserting identity", async () => {
  let captured: RequestInit | undefined;
  const client = new LifeTimeMachineClient({
    baseUrl: "http://localhost:8080/",
    session,
    fetch: async (_input, init) => {
      captured = init;
      return Response.json({ id: "timeline-1" });
    },
  });
  assert.deepEqual(await client.execute("B14", { targetAges: [25, 50] }, "idem-1"), { id: "timeline-1" });
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-access-token");
  assert.equal(headers.get("x-purpose"), "product");
  assert.equal(headers.has("x-tenant-id"), false);
  assert.equal(headers.has("x-actor-id"), false);
  assert.equal(headers.has("x-actor-role"), false);
  assert.equal(headers.get("idempotency-key"), "idem-1");
});

test("client retries bounded transient failures", async () => {
  let attempts = 0;
  const client = new LifeTimeMachineClient({
    baseUrl: "http://localhost:8080", session, maxRetries: 1,
    fetch: async () => ++attempts === 1 ? Response.json({ error: { code: "BUSY" } }, { status: 503 }) : Response.json({ capabilities: [] }),
  });
  assert.deepEqual(await client.listCapabilities(), []);
  assert.equal(attempts, 2);
});

test("client exposes structured permanent errors", async () => {
  const client = new LifeTimeMachineClient({
    baseUrl: "http://localhost:8080", session,
    fetch: async () => Response.json({ error: { code: "CONSENT_REQUIRED", message: "consent missing" } }, { status: 403 }),
  });
  await assert.rejects(client.execute("B14", {}, "idem-2"), (error: unknown) => error instanceof LifeTimeMachineApiError && error.code === "CONSENT_REQUIRED");
});
