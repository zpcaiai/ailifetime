import { randomUUID } from "node:crypto";

const REQUIRED_CATEGORIES = new Set(["auth", "tenant_idor", "upload_signed_url", "webhook_payment", "ssrf", "xss", "csrf", "admin"]);

export async function runDast(options) {
  const base = authorizedBaseUrl(options.baseUrl, options.authorization);
  const primaryToken = boundedSecret(options.primaryToken, "primary DAST token");
  const secondaryToken = boundedSecret(options.secondaryToken, "secondary DAST token");
  const primaryTenantId = token(options.primaryTenantId ?? "tenant-dast-a", "primary tenant ID");
  const marker = `dast-${randomUUID()}`;
  const strictProductionHeaders = options.profile === "ci" || options.profile === "production";
  const probes = [];
  const execute = async (name, category, operation) => {
    try {
      const evidence = await operation();
      probes.push({ name, category, status: "PASS", evidence });
    } catch (error) {
      probes.push({ name, category, status: "FAIL", error: error instanceof Error ? error.message : String(error) });
    }
  };

  await execute("missing bearer token is rejected", "auth", async () => {
    const response = await request(base, "/v1/queries", { method: "POST", purpose: "security_test", json: query("record.list", { collection: "security.dast" }) });
    return expectError(response, [401], ["AUTH_UNAUTHENTICATED"]);
  });
  await execute("invalid bearer token is rejected", "auth", async () => {
    const response = await request(base, "/v1/queries", { method: "POST", token: `${primaryToken}-invalid`, purpose: "security_test", json: query("record.list", { collection: "security.dast" }) });
    return expectError(response, [401], ["AUTH_UNAUTHENTICATED"]);
  });
  await execute("client tenant and role headers are rejected", "auth", async () => {
    const response = await request(base, "/v1/queries", {
      method: "POST", token: primaryToken, purpose: "security_test",
      headers: { "x-tenant-id": "tenant-attacker", "x-actor-role": "platform_admin" },
      json: query("record.list", { collection: "security.dast" }),
    });
    return expectError(response, [403], ["AUTH_FORBIDDEN"]);
  });

  const recordId = `idor-${randomUUID()}`;
  await execute("cross-tenant direct object reference fails closed", "tenant_idor", async () => {
    const create = await request(base, "/v1/commands", {
      method: "POST", token: primaryToken, purpose: "security_test", idempotencyKey: `create-${recordId}`,
      json: command("record.create", { collection: "security.dast", id: recordId, data: { marker } }),
    });
    expectStatus(create, [200]);
    const attack = await request(base, "/v1/queries", {
      method: "POST", token: secondaryToken, purpose: "security_test",
      json: query("record.get", { collection: "security.dast", id: recordId }),
    });
    const result = expectError(attack, [403, 404], ["AUTH_FORBIDDEN", "RESOURCE_NOT_FOUND", "TENANT_SCOPE_MISMATCH"]);
    if (attack.text.includes(marker)) throw new Error("cross-tenant response disclosed the protected marker");
    return result;
  });

  await execute("upload metadata fails closed when EXIF removal is false", "upload_signed_url", async () => {
    const response = await capability(base, primaryToken, "B64", {
      tenantId: primaryTenantId,
      uploadId: `upload-${randomUUID()}`,
      participantIds: ["participant-synthetic"],
      purpose: "security_test",
      mediaType: "image/jpeg",
      checksum: "0".repeat(64),
      chunkCount: 1,
      exifRemoved: false,
      serverRevalidation: true,
      idempotentAssembly: true,
    });
    return expectError(response, [400, 422], ["VALIDATION_FAILED"]);
  });
  await execute("nonexistent signed URL surface cannot redirect or leak", "upload_signed_url", async () => {
    const response = await request(base, `/v1/media/signed/${marker}?redirect=https%3A%2F%2Fevil.example`, { token: primaryToken, purpose: "security_test" });
    expectStatus(response, [404]);
    if (response.headers.get("location") !== null) throw new Error("absent signed URL surface emitted a redirect");
    if (response.text.includes(primaryToken)) throw new Error("signed URL response disclosed the bearer token");
    return { httpStatus: response.status, redirect: false, tokenDisclosed: false };
  });

  for (const endpointUrl of ["https://127.0.0.1/admin", "https://localhost/internal", "https://169.254.169.254/latest/meta-data/"]) {
    await execute(`webhook destination blocks ${new URL(endpointUrl).hostname}`, "ssrf", async () => {
      const response = await capability(base, primaryToken, "B106", {
        tenantId: primaryTenantId,
        endpointId: `endpoint-${randomUUID()}`,
        endpointUrl,
        eventTypes: ["order.updated"],
        signatureAlgorithm: "ed25519",
        signatureToleranceSeconds: 120,
        replayEventId: `replay-${randomUUID()}`,
        replayReason: "authorized negative security regression",
        consumerIdempotencyVerified: true,
        tenantActive: true,
      });
      return expectError(response, [400, 403, 422], ["VALIDATION_FAILED", "AUTH_FORBIDDEN"]);
    });
  }
  await execute("webhook registration requires signed bounded configuration", "webhook_payment", async () => {
    const response = await capability(base, primaryToken, "B106", {
      tenantId: primaryTenantId,
      endpointId: `endpoint-${randomUUID()}`,
      endpointUrl: "http://webhook.example.test/events",
      eventTypes: ["order.updated"],
      signatureAlgorithm: "none",
      signatureToleranceSeconds: 3_600,
      replayEventId: `replay-${randomUUID()}`,
      replayReason: "authorized negative security regression",
      consumerIdempotencyVerified: false,
      tenantActive: true,
    });
    return expectError(response, [400, 422], ["VALIDATION_FAILED"]);
  });
  await execute("payment endpoint rejects raw card credentials", "webhook_payment", async () => {
    const response = await capability(base, primaryToken, "B26", {
      tenantId: primaryTenantId,
      checkoutId: `checkout-${randomUUID()}`,
      quoteId: "quote-synthetic",
      quoteState: "active",
      paymentAuthorizationId: "authorization-synthetic",
      paymentState: "authorized",
      quotedMinor: 100,
      authorizedMinor: 100,
      currency: "USD",
      cardNumber: "4111111111111111",
    });
    return expectError(response, [400, 422], ["VALIDATION_FAILED"]);
  });
  await execute("payment amount mismatch fails closed", "webhook_payment", async () => {
    const response = await capability(base, primaryToken, "B26", {
      tenantId: primaryTenantId,
      checkoutId: `checkout-${randomUUID()}`,
      quoteId: "quote-synthetic",
      quoteState: "active",
      paymentAuthorizationId: "authorization-synthetic",
      paymentState: "authorized",
      quotedMinor: 100,
      authorizedMinor: 99,
      currency: "USD",
    });
    return expectError(response, [400, 503], ["DEPENDENCY_UNAVAILABLE", "VALIDATION_FAILED"]);
  });

  await execute("reflected XSS marker is absent and browser controls are present", "xss", async () => {
    const xss = `<img src=x onerror=alert('${marker}')>`;
    const response = await request(base, `/?q=${encodeURIComponent(xss)}`);
    expectStatus(response, [200]);
    const csp = response.headers.get("content-security-policy") ?? "";
    if (!csp.includes("object-src 'none'") || !csp.includes("frame-ancestors 'none'")) throw new Error("CSP is incomplete");
    if (strictProductionHeaders && /'unsafe-(?:inline|eval)'/.test(csp)) throw new Error("production CSP permits unsafe inline or evaluated content");
    if (strictProductionHeaders) {
      const hsts = response.headers.get("strict-transport-security") ?? "";
      const maximumAge = Number(/(?:^|;)\s*max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
      if (maximumAge < 31_536_000 || !/(?:^|;)\s*includeSubDomains(?:;|$)/i.test(hsts)) throw new Error("production HSTS must cover subdomains for at least one year");
    }
    if (response.headers.get("x-content-type-options") !== "nosniff") throw new Error("nosniff header is missing");
    if (response.text.includes(marker)) throw new Error("query string was reflected into HTML");
    return { httpStatus: response.status, csp: true, nosniff: true, strictProductionHeaders, reflected: false };
  });
  await execute("cross-site unauthenticated write cannot use ambient credentials", "csrf", async () => {
    const response = await request(base, "/v1/commands", {
      method: "POST", purpose: "security_test", headers: { origin: "https://evil.example" }, idempotencyKey: `csrf-${randomUUID()}`,
      json: command("record.create", { collection: "security.dast", data: { marker } }),
    });
    const result = expectError(response, [401], ["AUTH_UNAUTHENTICATED"]);
    if (response.headers.get("access-control-allow-origin") !== null) throw new Error("cross-origin write response grants CORS");
    if (response.headers.get("set-cookie") !== null) throw new Error("API establishes ambient cookie credentials");
    return { ...result, corsGranted: false, cookieCredential: false };
  });
  await execute("non-admin principal cannot approve security assurance", "admin", async () => {
    const response = await capability(base, secondaryToken, "B123", { tenantId: "tenant-dast-b" });
    return expectError(response, [403], ["AUTH_FORBIDDEN"]);
  });

  const covered = new Set(probes.filter((probe) => probe.status === "PASS").map((probe) => probe.category));
  const missingCategories = [...REQUIRED_CATEGORIES].filter((category) => !covered.has(category));
  const failed = probes.filter((probe) => probe.status === "FAIL");
  return {
    version: "ltm.dast-report.v1",
    targetOrigin: base.origin,
    status: failed.length === 0 && missingCategories.length === 0 ? "PASS" : "FAIL",
    summary: { total: probes.length, passed: probes.length - failed.length, failed: failed.length },
    coveredCategories: [...covered].sort(),
    missingCategories,
    probes,
  };
}

function authorizedBaseUrl(value, authorization) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("DAST base URL must be a credential-free origin");
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("DAST requires HTTPS except on loopback");
  if (!loopback) {
    if (authorization?.version !== "ltm.dast-authorization.v1" || authorization.targetOrigin !== url.origin || Date.parse(authorization.expiresAt) <= Date.now() || typeof authorization.ticketId !== "string" || typeof authorization.approvedBy !== "string") {
      throw new Error("non-loopback DAST requires an unexpired exact-target authorization document");
    }
  }
  return url;
}

async function capability(base, bearer, batchId, input) {
  return request(base, `/v1/capabilities/${batchId}`, {
    method: "POST", token: bearer, purpose: "security_test", idempotencyKey: `${batchId}-${randomUUID()}`, json: input,
  });
}

async function request(base, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const headers = new Headers(options.headers ?? {});
    if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
    if (options.purpose !== undefined) headers.set("x-purpose", options.purpose);
    if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);
    let body;
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    }
    const response = await fetch(new URL(path, base), {
      method: options.method ?? "GET", headers, body, redirect: "manual", signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 1_048_576) throw new Error("DAST response exceeded 1 MiB");
    const text = bytes.toString("utf8");
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, headers: response.headers, text, json };
  } finally { clearTimeout(timer); }
}

function expectStatus(response, statuses) {
  if (!statuses.includes(response.status)) throw new Error(`expected HTTP ${statuses.join("/")} but received ${response.status}`);
  return { httpStatus: response.status };
}

function expectError(response, statuses, codes) {
  expectStatus(response, statuses);
  const code = response.json?.error?.code;
  if (!codes.includes(code)) throw new Error(`expected error ${codes.join("/")} but received ${String(code)}`);
  return { httpStatus: response.status, errorCode: code };
}

function command(operation, input) { return { command: operation, input }; }
function query(operation, input) { return { query: operation, input }; }
function token(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function boundedSecret(value, label) {
  if (typeof value !== "string" || value.length < 12 || value.length > 4_096 || /\s/.test(value)) throw new Error(`${label} is missing or invalid`);
  return value;
}
