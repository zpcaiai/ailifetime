import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { MiniProgramValidationError, validateMiniProgram } from "./validate-miniprogram.mjs";

test("the checked-in mini-program has complete pages and fail-closed controls", () => {
  const result = validateMiniProgram();
  assert.equal(result.pages, 7);
  assert.equal(result.release, false);
  assert.equal(result.appIdMode, "development");
});

test("release validation rejects a tourist or placeholder app id", () => {
  assert.throws(
    () => validateMiniProgram(undefined, { release: true, appId: "touristappid" }),
    (error) => error instanceof MiniProgramValidationError && error.code === "PRODUCTION_APP_ID_REQUIRED",
  );
});

test("release validation accepts an explicitly enrolled app id shape", () => {
  const result = validateMiniProgram(undefined, { release: true, appId: "wx0123456789abcdef" });
  assert.equal(result.release, true);
  assert.equal(result.appIdMode, "production");
});

test("release API configuration accepts only an enrolled canonical public HTTPS origin", () => {
  const api = loadMiniCommonJs("../miniprogram/services/api.js", {
    require: () => ({ requireSession: () => ({ accessToken: "a".repeat(20), purpose: "product_operation" }), clear() {} }),
    wx: {
      getExtConfigSync: () => ({ apiBaseUrl: "https://api.product.cn", apiAllowedOrigins: ["https://api.product.cn"] }),
      getAccountInfoSync: () => ({ miniProgram: { envVersion: "release", appId: "wx0123456789abcdef" } }),
    },
  });
  assert.equal(api.configuration().baseUrl, "https://api.product.cn");
  for (const rejected of [
    "https://user:pass@api.product.cn",
    "https://api.product.cn/path",
    "https://127.0.0.1",
    "https://api.example",
    "https://api.product.test",
  ]) assert.throws(() => api.productionOrigin(rejected));
});

test("mini API caller cannot override bearer, purpose, or workload headers", () => {
  let requests = 0;
  const api = loadMiniCommonJs("../miniprogram/services/api.js", {
    require: () => ({ requireSession: () => ({ accessToken: "a".repeat(20), purpose: "product_operation" }), clear() {} }),
    wx: {
      getExtConfigSync: () => ({ apiBaseUrl: "https://api.product.cn", apiAllowedOrigins: ["https://api.product.cn"] }),
      getAccountInfoSync: () => ({ miniProgram: { envVersion: "release", appId: "wx0123456789abcdef" } }),
      request: () => { requests += 1; },
    },
  });
  assert.throws(() => api.publicRequest("/v1/session", { method: "GET", headers: { Authorization: "Bearer attacker" } }), /PROTECTED_API_HEADER/);
  assert.throws(() => api.request("/v1/session", { method: "GET", headers: { "X-Purpose": "attacker" } }), /PROTECTED_API_HEADER/);
  assert.throws(() => api.request("/v1/session", { method: "GET", headers: { "X-Ltm-Tenant-Id": "tenant-b" } }), /PROTECTED_API_HEADER/);
  assert.equal(requests, 0);
});

test("mini API preserves the closed server error code", async () => {
  const api = loadMiniCommonJs("../miniprogram/services/api.js", {
    require: () => ({ requireSession: () => ({ accessToken: "a".repeat(20), purpose: "product_operation" }), clear() {} }),
    wx: {
      getExtConfigSync: () => ({ apiBaseUrl: "https://api.product.cn", apiAllowedOrigins: ["https://api.product.cn"] }),
      getAccountInfoSync: () => ({ miniProgram: { envVersion: "release", appId: "wx0123456789abcdef" } }),
      request: (request) => request.success({ statusCode: 400, data: { error: { code: "VALIDATION_FAILED" } } }),
    },
  });
  await assert.rejects(api.publicRequest("/v1/example", { method: "GET" }), /VALIDATION_FAILED/);
});

test("mini API exposes only the closed per-operation purpose overrides", async () => {
  let sent;
  const api = loadMiniCommonJs("../miniprogram/services/api.js", {
    require: () => ({ requireSession: () => ({ accessToken: "a".repeat(20), purpose: "age_transformation" }), clear() {} }),
    wx: {
      getExtConfigSync: () => ({ apiBaseUrl: "https://api.product.cn", apiAllowedOrigins: ["https://api.product.cn"] }),
      getAccountInfoSync: () => ({ miniProgram: { envVersion: "release", appId: "wx0123456789abcdef" } }),
      request: (request) => { sent = request; request.success({ statusCode: 200, data: { data: {} } }); },
    },
  });
  await api.requestForPurpose("/v1/commands", "sharing", { data: { command: "consent.grant" } });
  assert.equal(sent.header["X-Purpose"], "sharing");
  await api.requestForPurpose("/v1/commands", "privacy_rights", { data: { command: "rights.submit" } });
  assert.equal(sent.header["X-Purpose"], "privacy_rights");
  await api.requestForPurpose("/v1/capabilities/B07", "age_transformation", { data: { assetId: "media-1" } });
  assert.equal(sent.header["X-Purpose"], "age_transformation");
  await assert.rejects(api.requestForPurpose("/v1/commands", "marketing", {}), /UNSUPPORTED_EXPLICIT_PURPOSE/);
});

test("mini upload preflight streams a whole-file SHA-256 digest", async () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x61, 0x62, 0x63, 0xff, 0xd9]);
  const sha256 = loadMiniCommonJs("../miniprogram/services/sha256.js", {});
  const upload = loadMiniCommonJs("../miniprogram/services/upload.js", {
    require: (specifier) => {
      if (specifier === "./api") return {};
      if (specifier === "./sha256") return sha256;
      throw new Error(`unexpected upload dependency: ${specifier}`);
    },
    wx: {
      getImageInfo: (input) => input.success({ type: "jpeg", width: 1024, height: 768 }),
      getFileSystemManager: () => ({
        stat: (input) => input.success({ stats: { size: bytes.byteLength } }),
        readFile: (input) => input.success({ data: bytes.buffer.slice(input.position, input.position + input.length) }),
      }),
    },
  });
  const result = await upload.preflight("/temporary/media.jpg");
  assert.equal(result.digestAlgorithm, "sha256");
  assert.equal(result.digest, "e7a09cd3d9f4d7b145ac939a5a8949765019e275bcc579e7de10a05960e36322");
  assert.equal(result.size, bytes.byteLength);
});

test("resumable upload overrides a product-operation session for create, chunks, complete, and cancel", async () => {
  const requests = [];
  let uploadSequence = 0;
  const wxRuntime = {
    getExtConfigSync: () => ({ apiBaseUrl: "https://api.product.cn", apiAllowedOrigins: ["https://api.product.cn"] }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "release", appId: "wx0123456789abcdef" } }),
    getRandomValues: (value) => { value.fill(7); },
    arrayBufferToBase64: () => "AQIDBA==",
    getFileSystemManager: () => ({
      readFile: (input) => input.success({ data: Uint8Array.from({ length: input.length }, (_, index) => index + 1).buffer }),
    }),
    request: (input) => {
      requests.push(input);
      if (input.url.endsWith("/v1/uploads")) {
        uploadSequence += 1;
        input.success({ statusCode: 200, data: { uploadId: `upload-${uploadSequence}`, nextOffset: 0 } });
      } else if (input.url.endsWith("/chunks")) {
        input.success({ statusCode: 200, data: { nextOffset: 4 } });
      } else if (input.url.endsWith("/complete")) {
        input.success({ statusCode: 200, data: { assetId: "asset-1" } });
      } else if (input.url.endsWith("/cancel")) {
        input.success({ statusCode: 200, data: { state: "cancelled" } });
      } else {
        throw new Error(`unexpected upload request: ${input.url}`);
      }
    },
  };
  const api = loadMiniCommonJs("../miniprogram/services/api.js", {
    require: () => ({ requireSession: () => ({ accessToken: "a".repeat(20), purpose: "product_operation" }), clear() {} }),
    wx: wxRuntime,
  });
  const sha256 = loadMiniCommonJs("../miniprogram/services/sha256.js", {});
  const upload = loadMiniCommonJs("../miniprogram/services/upload.js", {
    require: (specifier) => {
      if (specifier === "./api") return api;
      if (specifier === "./sha256") return sha256;
      throw new Error(`unexpected upload dependency: ${specifier}`);
    },
    wx: wxRuntime,
  });
  const file = { path: "/temporary/media.jpg", size: 4, digest: "d".repeat(64), digestAlgorithm: "sha256" };
  await upload.resumableUpload(file, () => {});
  await assert.rejects(upload.resumableUpload(file, () => {}, { cancelled: true }), /UPLOAD_CANCELLED/);
  assert.deepEqual(requests.map(({ url }) => url.replace("https://api.product.cn", "")), [
    "/v1/uploads",
    "/v1/uploads/upload-1/chunks",
    "/v1/uploads/upload-1/complete",
    "/v1/uploads",
    "/v1/uploads/upload-2/cancel",
  ]);
  assert.equal(requests.every(({ header }) => header["X-Purpose"] === "age_transformation"), true);
});

test("mini incremental SHA-256 matches the standard vector across chunk boundaries", () => {
  const { createSha256 } = loadMiniCommonJs("../miniprogram/services/sha256.js", {});
  const hasher = createSha256();
  hasher.update(Uint8Array.from([0x61]));
  hasher.update(Uint8Array.from([0x62, 0x63]));
  assert.equal(hasher.digestHex(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.throws(() => hasher.update(Uint8Array.of(0)), /SHA256_FINALIZED/);

  assert.equal(
    createSha256().digestHex(),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const longBytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 251);
  const longHasher = createSha256();
  longHasher.update(longBytes.subarray(0, 13));
  longHasher.update(longBytes.subarray(13, 777));
  longHasher.update(longBytes.subarray(777));
  assert.equal(longHasher.digestHex(), "4e4c294b331f7a2099a379bec34b9f9fc03dc46ab465d998f4d683da53487e6d");
});

test("mini session requires exact server projection binding", () => {
  const application = { globalData: {} };
  const session = loadMiniCommonJs("../miniprogram/services/session.js", {
    getApp: () => application,
    wx: { removeStorageSync() {} },
  });
  const candidate = {
    accessToken: "session-access-token-value-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tenantId: "tenant-a",
    actorId: "actor-a",
    roles: ["consumer"],
    purpose: "product_operation",
  };
  session.set(candidate);
  assert.equal(session.bindServerProjection(candidate, {
    session: {
      actorId: "actor-a", tenantId: "tenant-a", roles: ["consumer"], purpose: "product_operation",
      stepUp: false, guardianVerified: false, authenticationState: "server_verified",
    },
    requestId: "request-1",
  }).tenantId, "tenant-a");
  assert.throws(() => session.bindServerProjection(candidate, {
    session: {
      actorId: "actor-a", tenantId: "tenant-b", roles: ["consumer"], purpose: "product_operation",
      stepUp: false, guardianVerified: false, authenticationState: "server_verified",
    },
    requestId: "request-2",
  }), /SESSION_PROJECTION_MISMATCH/);
});

test("library restores and revokes multiple provider grants independently", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const calls = [];
  const projections = [
    {
      workId: "work-1", exportRecordId: "export-record-1", exportCommandId: "export-command-1",
      expiresAt, state: "active", providerOperationId: "provider-share-1",
    },
    {
      workId: "work-2", exportRecordId: "export-record-2", exportCommandId: "export-command-2",
      expiresAt, state: "active", providerOperationId: "provider-share-2",
    },
    {
      workId: "work-1", exportRecordId: "export-record-3", exportCommandId: "export-command-3",
      expiresAt, state: "active", providerOperationId: "provider-share-3",
    },
  ];
  const library = loadLibraryPage(async (path, options, purpose) => {
    calls.push({ path, options, purpose });
    const operation = options.data.query || options.data.command;
    if (operation === "record.list") {
      return { data: ["work-1", "work-2"].map((workId) => ({
        id: workId,
        data: { state: "ready", provenanceId: `provenance-${workId}` },
        participantIds: [`participant-${workId}`],
      })) };
    }
    if (operation === "share-grant.list") return { data: projections };
    if (operation === "share-grant.revoke") return { data: { state: "revocation_requested" } };
    if (operation === "share-grant.get") {
      const commandId = options.data.input.exportCommandId;
      const original = projections.find((grant) => grant.exportCommandId === commandId);
      return { data: { ...original, state: "revoked", providerOperationId: null } };
    }
    throw new Error(`unexpected library operation: ${operation}`);
  });

  await library.page.load();
  const timelineList = calls.find(({ options }) => options.data.query === "record.list");
  const shareGrantList = calls.find(({ options }) => options.data.query === "share-grant.list");
  assert.equal(timelineList.options.data.input.collection, "generation.timeline-commands");
  assert.equal(timelineList.purpose, "age_transformation");
  assert.equal(shareGrantList.purpose, "sharing");
  assert.equal(calls.some(({ options }) => options.data.query === "record.list" &&
    String(options.data.input.collection).startsWith("sharing.")), false);
  assert.deepEqual(Object.keys(library.page.shareGrants).sort(), ["work-1", "work-2"]);
  assert.equal(library.page.shareGrants["work-1"].length, 2);
  assert.equal(library.page.data.shareReadyIds.includes("work-1"), true);
  assert.equal(library.page.data.shareReadyIds.includes("work-2"), true);
  assert.match(library.page.onShareAppMessage({ target: { dataset: { id: "work-1" } } }).path, /provider-share-1/);
  assert.match(library.page.onShareAppMessage({ target: { dataset: { id: "work-2" } } }).path, /provider-share-2/);

  await library.page.revoke({ currentTarget: { dataset: { id: "work-1" } } });
  const revokes = calls.filter(({ options }) => options.data.command === "share-grant.revoke");
  assert.deepEqual(revokes.map(({ options }) => options.data.input.exportCommandId).sort(), ["export-command-1", "export-command-3"]);
  assert.equal(revokes.every(({ purpose }) => purpose === "sharing"), true);
  assert.equal(calls.filter(({ options }) => options.data.query === "share-grant.get")
    .every(({ purpose }) => purpose === "sharing"), true);
  assert.equal(library.page.shareGrants["work-1"], undefined);
  assert.equal(library.page.data.shareReadyIds.includes("work-1"), false);
  assert.equal(library.page.shareGrants["work-2"][0].reference, "provider-share-2");
  assert.equal(library.page.data.shareReadyIds.includes("work-2"), true);
  assert.equal(library.page.data.items.find((item) => item.id === "work-1").shareReady, false);
  assert.equal(library.page.data.items.find((item) => item.id === "work-2").shareReady, true);
  assert.equal(library.page.onShareAppMessage({ target: { dataset: { id: "work-1" } } }).path, "/pages/home/index");
  assert.match(library.page.onShareAppMessage({ target: { dataset: { id: "work-2" } } }).path, /provider-share-2/);
});

test("library grants exact self sharing consent before B10 and never grants for another participant", async () => {
  const calls = [];
  const self = loadLibraryPage(async (path, options, purpose) => {
    calls.push({ path, options, purpose });
    const operation = options.data.command || options.data.query;
    if (operation === "consent.grant") return { data: { value: { status: "active" } } };
    if (path === "/v1/capabilities/B10") {
      return { data: { recordId: "export-self-1", externalCommandId: "export-self-1" } };
    }
    if (operation === "share-grant.get") {
      return { data: {
        workId: "work-self-1", exportRecordId: "export-self-1", exportCommandId: "export-self-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "active", providerOperationId: "provider-self-1",
      } };
    }
    throw new Error(`unexpected self sharing operation: ${operation}`);
  });
  self.page.setData({
    items: [{ id: "work-self-1", participantIds: ["consumer-1"], provenanceId: "provenance-self-1" }],
    shareReadyIds: [],
  });
  await self.page.prepareShare({ currentTarget: { dataset: { id: "work-self-1" } } });
  const consent = calls.find(({ options }) => options.data.command === "consent.grant");
  const publish = calls.find(({ path }) => path === "/v1/capabilities/B10");
  assert.equal(consent.purpose, "sharing");
  assert.equal(
    JSON.stringify(consent.options.data.input.scope),
    JSON.stringify({ resource: "work:work-self-1", actions: ["share"] }),
  );
  assert.equal(consent.options.data.input.purpose, "sharing");
  assert.equal("evidenceHash" in consent.options.data.input, false);
  assert.equal("jurisdiction" in consent.options.data.input, false);
  assert.equal("locale" in consent.options.data.input, false);
  assert.equal(publish.purpose, "sharing");
  assert.equal(calls.filter(({ options }) => options.data.query === "share-grant.get")
    .every(({ purpose }) => purpose === "sharing"), true);

  const delegatedCalls = [];
  const delegated = loadLibraryPage(async (path, options, purpose) => {
    delegatedCalls.push({ path, options, purpose });
    if (path === "/v1/capabilities/B10") throw new Error("CONSENT_REQUIRED");
    throw new Error("unexpected delegated call");
  });
  delegated.page.setData({
    items: [{ id: "work-multi-1", participantIds: ["consumer-1", "consumer-2"], provenanceId: "provenance-multi-1" }],
    shareReadyIds: [],
  });
  await delegated.page.prepareShare({ currentTarget: { dataset: { id: "work-multi-1" } } });
  assert.equal(delegatedCalls.some(({ options }) => options.data.command === "consent.grant"), false);
  assert.equal(delegatedCalls.filter(({ path }) => path === "/v1/capabilities/B10").length, 1);
  assert.equal(delegated.page.data.error, "等待所有参与者或其监护人完成独立分享授权");
});

test("editor overrides a product-operation session with age transformation and requires B07 before B08/B14", async () => {
  const successfulCalls = [];
  const successful = loadEditorPage(async (path, options, purpose) => {
    successfulCalls.push({ path, options, purpose });
    if (path === "/v1/capabilities/B07") return { data: { state: "persisted" } };
    if (path === "/v1/capabilities/B14") return { data: { externalCommandId: "generation-command-1" } };
    return { data: {} };
  });
  successful.page.setData({
    assetId: "media-1",
    participantId: "consumer-1",
    consentAccepted: true,
    ages: "18,35,80",
  });
  await successful.page.generate();
  const ageConsent = successfulCalls.find(({ options }) => options.data?.command === "consent.grant");
  assert.ok(ageConsent);
  assert.equal(successfulCalls.every(({ purpose }) => purpose === "age_transformation"), true);
  assert.equal("evidenceHash" in ageConsent.options.data.input, false);
  assert.equal("jurisdiction" in ageConsent.options.data.input, false);
  assert.equal("locale" in ageConsent.options.data.input, false);
  const capabilityCalls = successfulCalls.filter(({ path }) => path.startsWith("/v1/capabilities/"));
  assert.deepEqual(capabilityCalls.map(({ path }) => path), [
    "/v1/capabilities/B07",
    "/v1/capabilities/B08",
    "/v1/capabilities/B14",
  ]);
  assert.deepEqual(Object.keys(capabilityCalls[0].options.data).sort(), ["assetId", "participantIds"]);
  assert.equal(capabilityCalls[1].options.data.sourceAssetId, "media-1");
  assert.equal(capabilityCalls[2].options.data.sourceAssetId, "media-1");
  assert.equal(successful.redirects.length, 1);

  const blockedCalls = [];
  const blocked = loadEditorPage(async (path, options, purpose) => {
    blockedCalls.push({ path, options, purpose });
    if (path === "/v1/capabilities/B07") return { data: { state: "verifying" } };
    return { data: {} };
  });
  blocked.page.setData({
    assetId: "media-2",
    participantId: "consumer-1",
    consentAccepted: true,
    ages: "18,80",
  });
  await blocked.page.generate();
  assert.deepEqual(
    blockedCalls.filter(({ path }) => path.startsWith("/v1/capabilities/")).map(({ path }) => path),
    ["/v1/capabilities/B07"],
  );
  assert.equal(blocked.redirects.length, 0);
  assert.equal(blocked.page.data.error, "MEDIA_INTAKE_NOT_ACCEPTED");
});

test("generation job polling uses the same age-transformation purpose as the created command", async () => {
  let page;
  const calls = [];
  runInNewContext(readFileSync(new URL("../miniprogram/pages/job/index.js", import.meta.url), "utf8"), {
    Page: (definition) => { page = definition; },
    require: () => ({
      requestForPurpose: async (path, purpose, options) => {
        calls.push({ path, purpose, options });
        return { data: { state: "succeeded", reconciliationState: "reconciled" } };
      },
    }),
    wx: { switchTab() {} },
    setTimeout: () => { throw new Error("terminal command must not schedule another poll"); },
    clearTimeout() {},
    Promise,
    Object,
    Set,
    Error,
  }, { filename: "miniprogram/pages/job/index.js" });
  assert.ok(page);
  page.setData = function setData(update) { Object.assign(this.data, update); };
  page.setData({ commandId: "generation-command-1" });
  await page.refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/queries");
  assert.equal(calls[0].purpose, "age_transformation");
  assert.equal(calls[0].options.data.query, "external-command.get");
  assert.equal(page.data.complete, true);
});

function loadEditorPage(request) {
  let page;
  const redirects = [];
  const activeSession = {
    accessToken: "session-access-token-value-1",
    actorId: "consumer-1",
    tenantId: "tenant-a",
    roles: ["consumer"],
    purpose: "product_operation",
  };
  const api = {
    idempotencyKey: (prefix) => `${prefix}-test-id`,
    request: (path, options) => request(path, options, undefined),
    requestForPurpose: (path, purpose, options) => request(path, options, purpose),
  };
  runInNewContext(readFileSync(new URL("../miniprogram/pages/editor/index.js", import.meta.url), "utf8"), {
    Page: (definition) => { page = definition; },
    require: (specifier) => {
      if (specifier === "../../services/api") return api;
      if (specifier === "../../services/session") return { get: () => activeSession, requireSession: () => activeSession };
      if (specifier === "../../policies/age-transformation") return { version: "privacy-v1", text: "age transformation consent" };
      throw new Error(`unexpected editor dependency: ${specifier}`);
    },
    wx: {
      navigateTo() {},
      redirectTo: (input) => redirects.push(input),
    },
    URL,
    Promise,
    Object,
    Set,
    Date,
    Array,
    Error,
    Number,
    encodeURIComponent,
  }, { filename: "miniprogram/pages/editor/index.js" });
  assert.ok(page);
  page.setData = function setData(update) { Object.assign(this.data, update); };
  return { page, redirects };
}

function loadLibraryPage(request) {
  let page;
  let nextTimer = 0;
  const timers = new Map();
  const activeSession = {
    accessToken: "session-access-token-value-1",
    actorId: "consumer-1",
    tenantId: "tenant-a",
    roles: ["consumer"],
    purpose: "product_operation",
  };
  const api = {
    idempotencyKey: (prefix) => `${prefix}-test-id`,
    request: (path, options) => request(path, options, undefined),
    requestForPurpose: (path, purpose, options) => request(path, options, purpose),
  };
  runInNewContext(readFileSync(new URL("../miniprogram/pages/library/index.js", import.meta.url), "utf8"), {
    Page: (definition) => { page = definition; },
    require: (specifier) => {
      if (specifier === "../../services/api") return api;
      if (specifier === "../../services/session") {
        return {
          get: () => activeSession,
          requireSession: () => activeSession,
          trackPrivateUrl() {},
          clearPrivateUrls() {},
        };
      }
      if (specifier === "../../policies/sharing") {
        return { version: "sharing-v1", text: "单独确认本作品的分享授权" };
      }
      throw new Error(`unexpected library dependency: ${specifier}`);
    },
    wx: {
      navigateTo() {},
      stopPullDownRefresh() {},
      showModal: (input) => input.success({ confirm: true, cancel: false }),
    },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    Promise,
    Object,
    Set,
    Date,
    Array,
    Error,
    Number,
    encodeURIComponent,
  }, { filename: "miniprogram/pages/library/index.js" });
  assert.ok(page);
  page.setData = function setData(update) { Object.assign(this.data, update); };
  return { page, timers };
}

function loadMiniCommonJs(relative, globals) {
  const module = { exports: {} };
  runInNewContext(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    module,
    exports: module.exports,
    URL,
    ArrayBuffer,
    Uint8Array,
    Uint32Array,
    Promise,
    Object,
    Set,
    Date,
    Array,
    Error,
    ...globals,
  }, { filename: relative });
  return module.exports;
}
