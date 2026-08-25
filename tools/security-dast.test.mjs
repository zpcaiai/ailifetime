import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runDast } from "../security/scanners/dast.mjs";

async function target(vulnerableSsrf = false) {
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const path = new URL(request.url, "http://localhost").pathname;
    response.setHeader("content-security-policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (path === "/") { response.statusCode = 200; response.setHeader("content-type", "text/html"); response.end("<html>safe</html>"); return; }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const fail = (status, code) => { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { code } })); };
    if (path.startsWith("/v1/media/signed/")) { fail(404, "RESOURCE_NOT_FOUND"); return; }
    if (bearer === undefined || bearer.endsWith("-invalid")) { fail(401, "AUTH_UNAUTHENTICATED"); return; }
    if (request.headers["x-tenant-id"] !== undefined) { fail(403, "AUTH_FORBIDDEN"); return; }
    if (path === "/v1/queries" && bearer === "secondary-token-synthetic") { fail(404, "RESOURCE_NOT_FOUND"); return; }
    if (path === "/v1/commands") {
      if (body.command === "record.create" && body.input?.processingPurpose !== "security_test") {
        fail(422, "VALIDATION_FAILED");
        return;
      }
      response.statusCode = 200; response.end(JSON.stringify({ data: { ok: true } })); return;
    }
    if (path === "/v1/capabilities/B123" && bearer === "secondary-token-synthetic") { fail(403, "AUTH_FORBIDDEN"); return; }
    if (path === "/v1/capabilities/B106" && vulnerableSsrf && String(body.endpointUrl ?? "").startsWith("https://")) { response.statusCode = 200; response.end(JSON.stringify({ data: { accepted: true } })); return; }
    if (path.startsWith("/v1/capabilities/")) { fail(400, "VALIDATION_FAILED"); return; }
    fail(404, "RESOURCE_NOT_FOUND");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

test("executes every required live negative-security category", async (t) => {
  const fixture = await target(); t.after(() => fixture.server.close());
  const report = await runDast({ baseUrl: fixture.url, primaryToken: "primary-token-synthetic", secondaryToken: "secondary-token-synthetic", profile: "ci" });
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.missingCategories, []);
  assert.equal(report.coveredCategories.length, 8);
});

test("detects a webhook SSRF regression instead of accepting a keyword assertion", async (t) => {
  const fixture = await target(true); t.after(() => fixture.server.close());
  const report = await runDast({ baseUrl: fixture.url, primaryToken: "primary-token-synthetic", secondaryToken: "secondary-token-synthetic" });
  assert.equal(report.status, "FAIL");
  assert.ok(report.probes.some((probe) => probe.category === "ssrf" && probe.status === "FAIL"));
});
