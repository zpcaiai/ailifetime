import assert from "node:assert/strict";
import { readFileSync, cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { MiniProgramValidationError, validateMiniProgram } from "./validate-miniprogram.mjs";

test("the checked-in mini-program has complete pages and fail-closed controls", () => {
  const result = validateMiniProgram();
  assert.equal(result.pages, 11);
  assert.ok(JSON.parse(readFileSync(new URL("../miniprogram/app.json", import.meta.url))).pages.includes("pages/wardrobe/index"));
  const cover = readFileSync(new URL("../miniprogram/assets/wardrobe-invite.png", import.meta.url));
  assert.deepEqual([...cover.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  assert.equal(cover.readUInt32BE(16),500);assert.equal(cover.readUInt32BE(20),400);
  assert.equal(result.release, false);
  assert.equal(result.appIdMode, "development");
});

test("manifest rejects compiler-invalid private-info entries while keeping platform privacy mandatory", () => {
  const root = mkdtempSync(join(tmpdir(), "ltm-mini-manifest-"));
  try {
    cpSync(fileURLToPath(new URL("..", import.meta.url)), root, { recursive: true, filter: (path) => !path.includes("node_modules") && !path.includes("/dist") });
    const appPath = join(root, "miniprogram/app.json"), app = JSON.parse(readFileSync(appPath, "utf8"));
    for (const requiredPrivateInfos of [["chooseMedia"], ["saveImageToPhotosAlbum"], ["getLocation", "getLocation"], "getLocation"]) {
      writeFileSync(appPath, JSON.stringify({ ...app, requiredPrivateInfos }));
      assert.throws(() => validateMiniProgram(root), (error) => error.code === "PRIVATE_INFO_DECLARATION_INVALID");
    }
    writeFileSync(appPath, JSON.stringify(app));
    const projectPath = join(root, "project.config.json"), project = JSON.parse(readFileSync(projectPath, "utf8"));
    writeFileSync(projectPath, JSON.stringify({ ...project, __usePrivacyCheck__: false }));
    assert.throws(() => validateMiniProgram(root), (error) => error.code === "PRIVACY_PLATFORM_GATE_MISSING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-program capability policy validates the closed portalId projection", () => {
  const application = { globalData: { policy: {
    schemaVersion: "ltm.visible-capability-manifest.v1",
    capabilities: [{
      batchId: "B10", skill: "building-consumer-time-machine", operation: "publishExport",
      permission: "record:create", portalId: "consumer", mode: "external-command",
      requirements: ["B10-R01", "B10-R02", "B10-R03", "B10-R04", "B10-R05"], requiresExternalEvidence: false,
    }],
    portals: [{ id: "consumer", skills: ["building-consumer-time-machine"], capabilityCount: 1 }],
    count: 1,
    requestId: "mini-policy-test",
  } } };
  const policy = loadMiniCommonJs("../miniprogram/services/policy.js", { getApp: () => application });
  assert.equal(policy.routeAllowed("consumer", ["consumer"]), true);
  assert.equal(policy.capabilitiesAllowed(["B10"], ["consumer"]), true);
  assert.throws(() => policy.requireCapabilities(["B14"], ["consumer"]), /CLIENT_CAPABILITY_FORBIDDEN/);
  application.globalData.policy.capabilities[0].portal = "consumer";
  assert.throws(() => policy.requireManifest(), /CLIENT_MANIFEST_UNAVAILABLE/);
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
  const cancelledUpload = { cancelled: false };
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
        if (uploadSequence === 2) cancelledUpload.cancelled = true;
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
  await assert.rejects(upload.resumableUpload(file, () => {}, cancelledUpload), /UPLOAD_CANCELLED/);
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
    if (path.startsWith("/v1/photo-purchases")) return { data: { purchaseId: "photo-order-1", commandId: "generation-command-1" } };
    return { data: {} };
  });
  successful.page.setData({
    assetId: "media-1",
    participantId: "consumer-1",
    consentAccepted: true,
    ages: Array.from({length:21},(_,i)=>i*5).join(","),
    currentAge: "35",
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
  ]);
  assert.deepEqual(Object.keys(capabilityCalls[0].options.data).sort(), ["assetId", "participantIds"]);
  assert.equal(capabilityCalls[1].options.data.sourceAssetId, "media-1");
  const purchasedGeneration = successfulCalls.find(c=>c.path==="/v1/photo-purchases").options.data.generation;
  assert.equal(purchasedGeneration.sourceAssetId, "media-1");
  assert.equal(purchasedGeneration.templateId, capabilityCalls[1].options.data.templateId);
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
    ages: Array.from({length:21},(_,i)=>i*5).join(","),
    currentAge: "35",
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
        return { data: { commandState: "succeeded", state: "pending", reconciliationState: "clear" } };
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
  assert.equal(calls[0].path, "/v1/timelines/generation-command-1");
  assert.equal(calls[0].purpose, "age_transformation");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(page.data.complete, true);
});

test("WeChat payment calls wx.requestPayment but remains pending until the exact server projection is paid", async () => {
  const checkout = { checkoutId: "checkout-12345678" };
  const intent = {
    schemaVersion: "ltm.wechat.payment-intent.v1", checkoutId: checkout.checkoutId, orderId: "order-12345678", amountMinor: 1299,
    currency: "CNY", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    parameters: { timeStamp: Math.floor(Date.now() / 1000).toString(), nonceStr: "nonce-12345678", package: "prepay_id=prepay_12345678", signType: "RSA", paySign: "A".repeat(64) },
  };
  let nativeRequest;
  const calls = [];
  const commerce = loadMiniCommonJs("../miniprogram/services/commerce.js", {
    require: () => ({
      idempotencyKey: () => "wechat-pay-test-id-0001",
      requestForPurpose: async (path, purpose, options) => {
        assert.equal(purpose, "commerce");
        calls.push({ path, options });
        if (path === "/v1/wechat/payments") return { data: intent };
        return { data: { schemaVersion: "ltm.wechat.payment-projection.v1", checkoutId: intent.checkoutId, orderId: intent.orderId, amountMinor: intent.amountMinor, currency: "CNY", state: "paid", version: 2, updatedAt: new Date().toISOString(), providerTransactionReference: "wechat-provider-transaction-001" } };
      },
    }),
    wx: { requestPayment: (input) => { nativeRequest = input; } },
    setTimeout,
  });
  const first = commerce.requestPayment(checkout);
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(commerce.requestPayment(checkout), /PAYMENT_ALREADY_IN_PROGRESS/);
  assert.deepEqual(Object.keys(nativeRequest).sort(), ["fail", "nonceStr", "package", "paySign", "signType", "success", "timeStamp"]);
  nativeRequest.success({ errMsg: "requestPayment:ok" });
  const accepted = await first;
  assert.equal(accepted.state, "native_payment_accepted_pending_server_verification");
  assert.deepEqual(Object.keys(calls[0].options.data), ["checkoutId"]);
  assert.equal(calls[0].options.data.checkoutId, checkout.checkoutId);
  assert.equal(Object.hasOwn(calls[0].options.data, "amountMinor"), false);
  const terminal = await commerce.projectPayment(accepted.orderId);
  assert.equal(terminal.state, "paid"); assert.equal(calls[1].path, `/v1/wechat/payments/${intent.orderId}`); assert.equal(calls[1].options.method, "GET");
});

test("WeChat payment rejects native cancellation and forged amount or terminal state", async () => {
  const checkout = { checkoutId: "checkout-12345678" };
  const base = { schemaVersion: "ltm.wechat.payment-intent.v1", checkoutId: checkout.checkoutId, orderId: "order-12345678", amountMinor: 1299, currency: "CNY", expiresAt: new Date(Date.now() + 60_000).toISOString(), parameters: { timeStamp: Math.floor(Date.now() / 1000).toString(), nonceStr: "nonce-12345678", package: "prepay_id=prepay_12345678", signType: "RSA", paySign: "A".repeat(64) } };
  let nativeRequest; let nativeReadyResolve; const nativeReady = new Promise((resolve) => { nativeReadyResolve = resolve; });
  const commerce = loadMiniCommonJs("../miniprogram/services/commerce.js", {
    require: () => ({ idempotencyKey: () => "wechat-pay-test-id-0001", requestForPurpose: async (path) => path === "/v1/wechat/payments" ? { data: base } : { data: { schemaVersion: "ltm.wechat.payment-projection.v1", checkoutId: base.checkoutId, orderId: base.orderId, amountMinor: 1, currency: "CNY", state: "paid", version: 2, updatedAt: new Date().toISOString(), providerTransactionReference: "provider-transaction-00001" } } }),
    wx: { requestPayment: (input) => { nativeRequest = input; nativeReadyResolve(); } }, setTimeout,
  });
  const payment = commerce.requestPayment(checkout); await nativeReady; nativeRequest.fail({ errMsg: "requestPayment:fail cancel" });
  await assert.rejects(payment, /PAYMENT_USER_CANCELLED/);
  await assert.rejects(commerce.projectPayment(base.orderId), /PAYMENT_PROJECTION_INVALID/);
  await assert.rejects(commerce.requestPayment({ ...checkout, amountMinor: 1 }), /PAYMENT_CHECKOUT_INVALID/);
  assert.throws(() => commerce.validatePaymentIntent({ ...base, checkoutId: "different-checkout-1" }, checkout), /PAYMENT_INTENT_INVALID/);
});

test("subscription messages authorize only native-accepted server-enrolled templates and customer service uses a short grant", async () => {
  const offer = { schemaVersion: "ltm.wechat.subscription-offer.v1", offerId: "offer-12345678", revision: 2, templateIds: ["template_identifier_000001", "template_identifier_000002"], expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const calls = []; let subscribeRequest; let serviceRequest;
  const messaging = loadMiniCommonJs("../miniprogram/services/messaging.js", {
    require: () => ({
      idempotencyKey: () => "messaging-test-id-000001",
      requestForPurpose: async (path, purpose, options) => {
        calls.push({ path, purpose, options });
        if (path === "/v1/wechat/subscription-authorizations") return { data: { schemaVersion: "ltm.wechat.subscription-authorization.v1", offerId: offer.offerId, revision: offer.revision, state: "server_recorded", authorizationReferences: ["subscription-authorization-reference-0001"] } };
        if (path === "/v1/wechat/customer-service-grants") return { data: { schemaVersion: "ltm.wechat.customer-service-grant.v1", corpId: "ww0123456789abcdef", extInfoUrl: "https://service.product.cn/chat?grant=opaque", ticketId: "support-ticket-00001", expiresAt: new Date(Date.now() + 60_000).toISOString() } };
        return { data: offer };
      },
    }),
    wx: {
      requestSubscribeMessage: (input) => { subscribeRequest = input; input.success({ [offer.templateIds[0]]: "accept", [offer.templateIds[1]]: "reject" }); },
      openCustomerServiceChat: (input) => { serviceRequest = input; input.success({}); },
    },
  });
  assert.deepEqual(Array.from((await messaging.loadSubscriptionOffer()).templateIds), offer.templateIds);
  const authorized = await messaging.requestSubscriptions(offer);
  assert.equal(authorized.authorizationReferences.length, 1); assert.deepEqual(Array.from(subscribeRequest.tmplIds), offer.templateIds);
  const command = calls.find(({ path }) => path === "/v1/wechat/subscription-authorizations");
  assert.deepEqual(Array.from(command.options.data.acceptedTemplateIds), [offer.templateIds[0]]); assert.equal(command.purpose, "notifications");
  const service = await messaging.openCustomerService(); assert.equal(service.ticketId, "support-ticket-00001");
  assert.equal(serviceRequest.corpId, "ww0123456789abcdef"); assert.equal(serviceRequest.extInfo.url, "https://service.product.cn/chat?grant=opaque");
  assert.throws(() => messaging.validateOffer({ ...offer, templateIds: ["unregistered"] }), /SUBSCRIPTION_OFFER_INVALID/);
});

test("privacy gate drives official exposure, agree and disagree events before chooseMedia", async () => {
  const application = { globalData: { privacyRequest: null } }; let listener; let current; const events = []; const navigations = [];
  const privacy = loadMiniCommonJs("../miniprogram/services/privacy.js", {
    getApp: () => application,
    wx: {
      onNeedPrivacyAuthorization: (callback) => { listener = callback; },
      requirePrivacyAuthorize: (input) => { current = input; listener((event) => { events.push(event.event); if (event.event === "agree") input.success(); if (event.event === "disagree") input.fail(); }, { referrer: "chooseMedia" }); },
      navigateTo: (input) => navigations.push(input.url),
    },
  });
  privacy.install(); const allowed = privacy.requireAuthorization(); privacy.decide(true); await allowed;
  assert.deepEqual(events, ["exposureAuthorization", "agree"]); assert.equal(privacy.isAuthorized(), true); assert.equal(navigations[0], "/pages/privacy/index");
  const denied = privacy.requireAuthorization(); privacy.decide(false); await assert.rejects(denied, /PRIVACY_AUTHORIZATION_DENIED/); assert.equal(current !== undefined, true);
});

test("editor defaults to 21 ages, binds original age and blocks duplicate in-flight submissions", async () => {
  const calls = [];
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const editor = loadEditorPage(async (path, options) => {
    calls.push({ path, options });
    if (path === "/v1/commands") await wait;
    if (path === "/v1/capabilities/B07") return { data: { state: "persisted" } };
    if (path.startsWith("/v1/photo-purchases")) return { data: { purchaseId: "photo-order-21", commandId: "generation-21" } };
    return { data: {} };
  });
  assert.equal(editor.page.data.ages, Array.from({ length: 21 }, (_, index) => index * 5).join(","));
  editor.page.setData({ assetId: "media-1", participantId: "consumer-1", consentAccepted: true, currentAge: "35" });
  const first = editor.page.generate();
  await editor.page.generate();
  assert.equal(calls.length, 1);
  release();
  await first;
  const request = calls.find((call) => call.path === "/v1/photo-purchases");
  assert.ok(request);
  assert.equal(request.options.data.sku, "lifespan-21");
  assert.equal(request.options.data.generation.timelineProfile, "lifespan-21-v1");
  assert.equal(request.options.data.generation.currentAge, 35);
  assert.deepEqual(Array.from(request.options.data.generation.targetAges), Array.from({ length: 21 }, (_, index) => index * 5));
  assert.equal(editor.redirects.length, 1);
});

test("editor rejects empty age tokens and missing or invalid source age before granting consent", async () => {
  for (const delta of [{ ages: "5,,10" }, { ages: ",5,10" }, { ages: "0,5," }, { currentAge: "" }, { currentAge: "101" }, { currentAge: "-1" }, { currentAge: "3.5" }]) {
    let calls = 0;
    const editor = loadEditorPage(async () => { calls++; return { data: {} }; });
    editor.page.setData({ assetId: "media-1", participantId: "consumer-1", consentAccepted: true, currentAge: "35", ...delta });
    await editor.page.generate();
    assert.equal(calls, 0);
    assert.equal(editor.page.data.error, "PARTICIPANT_OR_AGES_INVALID");
  }
});

test("job page resumes polling after foregrounding and ignores a late hidden-page response", async () => {
  let resolvePending;
  let calls = 0;
  const pending = new Promise((resolve) => { resolvePending = resolve; });
  const job = loadJobPage(async () => {
    calls++;
    if (calls === 1) return pending;
    return { data: { commandState: "acknowledged", reconciliationState: "clear" } };
  });
  job.page.setData({ commandId: "generation-1" });
  const first = job.page.refresh();
  job.page.onHide();
  resolvePending({ data: { commandState: "succeeded", reconciliationState: "clear" } });
  await first;
  assert.equal(job.page.data.state, "requested");
  assert.equal(job.timers.size, 0);
  job.page.onShow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(job.page.data.state, "acknowledged");
  assert.equal(job.timers.size, 1);
  job.page.onUnload();
  assert.equal(job.timers.size, 0);
});

test("job provider success is not photo acceptance and terminal jobs expose the recovery library", async () => {
  for (const state of ["succeeded", "failed", "cancelled", "compensated"]) {
    const job = loadJobPage(async () => ({ data: { commandState: state, state: "pending", reconciliationState: "clear" } }));
    job.page.setData({ commandId: "generation-1" });
    await job.page.refresh();
    assert.equal(job.page.data.complete, true);
    assert.equal(job.page.data.canOpenLibrary, true);
    assert.equal(job.timers.size, 0);
    if (state === "succeeded") assert.match(job.page.data.title, /待核验/);
  }
  const frozen = loadJobPage(async () => ({ data: { commandState: "acknowledged", reconciliationState: "reconciliation_required" } }));
  frozen.page.setData({ commandId: "generation-1" });
  await frozen.page.refresh();
  assert.equal(frozen.timers.size, 0);
  assert.equal(frozen.page.data.canOpenLibrary, false);
});

test("editor replays an uncertain purchase intent with the same body and keys, and blocks changed parameters", async () => {
  const calls = [];
  let generationAttempts = 0;
  const editor = loadEditorPage(async (path, options) => {
    calls.push({ path, options });
    if (path === "/v1/capabilities/B07") return { data: { state: "persisted" } };
    if (path === "/v1/photo-purchases") {
      if (++generationAttempts === 1) throw new Error("NETWORK_UNAVAILABLE");
      return { data: { purchaseId: "photo-original", commandId: "original-command" } };
    }
    if (path.endsWith("/fulfill")) return { data: { commandId: "original-command" } };
    return { data: {} };
  });
  editor.page.setData({ assetId: "media-1", participantId: "consumer-1", consentAccepted: true, currentAge: "35" });
  await editor.page.generate();
  assert.equal(editor.page.data.error, "NETWORK_UNAVAILABLE");
  editor.page.setData({ currentAge: "40" });
  await editor.page.generate();
  assert.equal(editor.page.data.error, "GENERATION_RECONCILIATION_REQUIRED");
  assert.equal(generationAttempts, 1);
  editor.page.setData({ currentAge: "35" });
  await editor.page.generate();
  const generations = calls.filter((call) => call.path === "/v1/photo-purchases");
  assert.equal(generations.length, 2);
  assert.deepEqual(generations[1].options, generations[0].options);
  const consents = calls.filter((call) => call.path === "/v1/commands");
  assert.deepEqual(consents[1].options, consents[0].options);
  assert.equal(editor.redirects.length, 1);
});

function loadJobPage(request) {
  let page;
  let timerId = 0;
  const timers = new Map();
  runInNewContext(readFileSync(new URL("../miniprogram/pages/job/index.js", import.meta.url), "utf8"), {
    Page: (definition) => { page = definition; },
    require: () => ({ requestForPurpose: request }),
    wx: { switchTab() {} },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  assert.ok(page);
  page.setData = function setData(update) { Object.assign(this.data, update); };
  return { page, timers };
}

function loadEditorPage(request) {
  const purchaseCatalog=loadMiniCommonJs('../miniprogram/services/photo-purchases.js',{require:()=>({})});
  let page;
  let nextId = 0;
  const redirects = [];
  const activeSession = {
    accessToken: "session-access-token-value-1",
    actorId: "consumer-1",
    tenantId: "tenant-a",
    roles: ["consumer"],
    purpose: "product_operation",
  };
  const api = {
    idempotencyKey: (prefix) => `${prefix}-test-${++nextId}`,
    request: (path, options) => request(path, options, undefined),
    requestForPurpose: (path, purpose, options) => request(path, options, purpose),
  };
  runInNewContext(readFileSync(new URL("../miniprogram/pages/editor/index.js", import.meta.url), "utf8"), {
    Page: (definition) => { page = definition; },
    require: (specifier) => {
      if (specifier === "../../services/api") return api;
      if (specifier === "../../services/photo-purchases") return {
        ...purchaseCatalog,errorText:error=>error.message,
        create:async(input,key)=>(await request("/v1/photo-purchases",{data:input,headers:{"Idempotency-Key":key}},"age_transformation")).data,
        get:async id=>(await request(`/v1/photo-purchases/${id}`,{method:"GET"},"age_transformation")).data,
        execute:async quote=>(await request(`/v1/photo-purchases/${quote.purchaseId}/fulfill`,{data:{}},"age_transformation")).data,
      };
      if (specifier === "../../services/session") return { get: () => activeSession, requireSession: () => activeSession };
      if (specifier === "../../services/policy") return { requireCapabilities() {} };
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

test("a late timeline fetch after hide cannot restore private image metadata", async () => {
  let resolvePending;
  const pending = new Promise(resolve => { resolvePending = resolve; });
  const library = loadLibraryPage(async () => pending);
  const opening = library.page.openTimeline({currentTarget:{dataset:{id:"root"}}});
  await Promise.resolve(); await Promise.resolve();
  library.page.onHide();
  resolvePending({data:{commandId:"root",expectedCount:1,nodes:[{targetAge:0,status:"ready"}]}});
  await opening;
  assert.equal(library.page.data.delivery,null);assert.equal(library.page.data.previewPath,"");assert.equal(library.page.data.activeCommandId,"");
});

test("authorization failure clears previously cached timeline photos", async () => {
  let cleared = 0;
  const library = loadLibraryPage(async () => { throw new Error("CONSENT_WITHDRAWN"); }, { clearAll: async () => { cleared++; }, remove: async () => {}, download: async () => "", save: async () => {} });
  library.page.setData({ activeCommandId: "root", previewPath: "private-temp", selectedNode: { status: "ready" }, delivery: { nodes: [] } });
  await library.page.refreshTimeline();
  assert.equal(cleared,1);assert.equal(library.page.data.previewPath,"");assert.equal(library.page.data.delivery,null);
});

test("library renders21 ages, selects original, retries one failed age and clears private state on hide", async () => {
  const calls = [], removed = [], saves = [];
  const view = { commandId: "root", expectedCount: 21, readyCount: 20, state: "partial", aiLabel: "AI 创作",
    nodes: Array.from({ length: 21 }, (_, i) => ({ nodeId: `age-${i*5}`, targetAge: i*5, status: i === 20 ? "failed" : "ready", attempts: 0, canRetry: i === 20,
      downloadPath: i === 20 ? null : `/v1/timelines/root/nodes/${i*5}/image`, asset: { sha256: `${i}`.padStart(64,"0"), width: 1024, height: 1024 } })) };
  const media = { clearAll: async () => { removed.push("all"); }, remove: async path => { removed.push(path); }, download: async node => `temp-${node.targetAge}`, save: async node => { saves.push(node.targetAge); } };
  const library = loadLibraryPage(async (path, options, purpose) => {
    calls.push({path, options, purpose});
    if (path.endsWith("/retry")) { view.nodes[20].status = "retrying"; view.nodes[20].canRetry = false; return {data:{commandId:"retry"}}; }
    if (path === "/v1/timelines/root") return {data: structuredClone(view)};
    throw new Error(path);
  }, media);
  await library.page.openTimeline({currentTarget:{dataset:{id:"root"}}});
  assert.equal(library.page.data.delivery.nodes.length,21);assert.equal(library.page.data.previewPath,"temp-0");
  await library.page.saveOriginal();assert.deepEqual(saves,[0]);
  await library.page.selectAge({currentTarget:{dataset:{age:100}}});await library.page.retryAge();
  const retry = calls.find(call => call.path.endsWith("/retry"));
  assert.deepEqual(JSON.parse(JSON.stringify(retry.options.data)),{targetAge:100,attempt:1});assert.equal(retry.purpose,"age_transformation");
  assert.equal(library.page.data.selectedNode.status,"retrying");assert.equal(library.timers.size,1);
  library.page.onHide();assert.equal(library.page.data.delivery,null);assert.equal(library.page.data.previewPath,"");assert.equal(library.timers.size,0);assert.ok(removed.includes("all"));
});

function loadLibraryPage(request, media = { clearAll: async () => {}, remove: async () => {}, download: async () => "test-temp-path", save: async () => {} }) {
  let page;
  const navigations = [];
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
      if (specifier === "../../services/timeline-media") return media;
      if (specifier === "../../services/policy") return { requireCapabilities() {} };
      throw new Error(`unexpected library dependency: ${specifier}`);
    },
    wx: {
      navigateTo(input) { navigations.push(input); },
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
  return { page, timers, navigations };
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

test("editor sends every11/21 standard/HD tier for both subjects with exact ages and prices",async()=>{
 for(const count of [11,21])for(const quality of ['standard','hd'])for(const couple of [false,true]){
  const calls=[],editor=loadEditorPage(async(path,options)=>{calls.push({path,options});return{data:path.endsWith('/B07')?{state:'persisted'}:path==='/v1/photo-purchases'?{purchaseId:'tier-quote'}:path.endsWith('/fulfill')?{commandId:'tier-command'}:{}};});
  editor.page.onLoad({assetId:'source-1'});editor.page.setData({currentAge:'35',consentAccepted:true,subjectMode:couple?'couple':'single',partnerParticipantId:'partner-1',partnerCurrentAge:'32'});
  editor.page.albumCountChanged({currentTarget:{dataset:{value:String(count)}}});editor.page.imageQualityChanged({currentTarget:{dataset:{value:quality}}});
  const amount=quality==='standard'?(count===11?'¥19.90':'¥29.90'):(count===11?'¥29.90':'¥49.90');assert.equal(editor.page.data.priceLifespan,amount);
  const ages=Array.from({length:count},(_,i)=>i*(count===11?10:5));assert.deepEqual(Array.from(editor.page.data.ages.split(',').map(Number)),ages);
  await editor.page.generate();assert.equal(editor.page.data.error,'');const data=calls.find(c=>c.path==='/v1/photo-purchases').options.data;
  assert.equal(data.sku,count===21&&quality==='hd'?'lifespan-21':`lifespan-${count}-${quality}`);assert.equal(data.generation.imageQuality,quality);assert.equal(data.generation.timelineProfile,`lifespan-${count}${couple?'-couple':''}-v1`);assert.deepEqual(Array.from(data.generation.targetAges),ages);assert.equal(editor.redirects.length,1);
 }
 const view=readFileSync(new URL('../miniprogram/pages/editor/index.wxml',import.meta.url),'utf8');for(const text of ['albumCountChanged','imageQualityChanged','1536 × 1536','2048 × 2048','保存 30 天'])assert.ok(view.includes(text),text);
});
test("tier changes during intake or uncertain create cannot alter an in-flight order or create a second purchase",async()=>{
 let release;const hold=new Promise(r=>release=r),calls=[];
 const editor=loadEditorPage(async(path,options)=>{calls.push({path,options});if(path.endsWith('/B07')){await hold;return{data:{state:'persisted'}};}if(path==='/v1/photo-purchases')throw new Error('NETWORK_UNAVAILABLE');return{data:{}};});
 editor.page.onLoad({assetId:'source-1'});editor.page.setData({currentAge:'35',consentAccepted:true});const pending=editor.page.generate();
 editor.page.albumCountChanged({currentTarget:{dataset:{value:'11'}}});editor.page.imageQualityChanged({currentTarget:{dataset:{value:'standard'}}});assert.equal(editor.page.data.albumCount,21);assert.equal(editor.page.data.imageQuality,'hd');
 release();await pending;const first=calls.find(c=>c.path==='/v1/photo-purchases');assert.equal(first.options.data.generation.imageQuality,'hd');
 editor.page.albumCountChanged({currentTarget:{dataset:{value:'11'}}});editor.page.imageQualityChanged({currentTarget:{dataset:{value:'standard'}}});const before=calls.length;await editor.page.generate();assert.equal(editor.page.data.error,'GENERATION_RECONCILIATION_REQUIRED');assert.equal(calls.length,before);
});
test("editor supports both subjects and both play modes without granting partner consent", async () => {
  for (const subjectMode of ["single", "couple"]) for (const playMode of ["lifespan", "age"]) for (const targetAge of ["0", "37", "100"]) {
    const calls=[]; const editor=loadEditorPage(async(path,options)=>{calls.push({path,options});if(path.endsWith('B07'))return{data:{state:'persisted'}};if(path.startsWith('/v1/photo-purchases'))return{data:{purchaseId:'photo-mode',commandId:'mode-command'}};return{data:{}};});
    editor.page.setData({assetId:'source',participantId:'consumer-1',currentAge:'35',consentAccepted:true,subjectMode,playMode,targetAge,partnerParticipantId:'partner',partnerCurrentAge:'32'});
    await editor.page.generate();
    const grants=calls.filter(c=>c.options.data.command==='consent.grant');assert.equal(grants.length,1);assert.equal(grants[0].options.data.input.participantId,'consumer-1');
    const quoted=calls.find(c=>c.path==='/v1/photo-purchases').options.data;
    assert.equal(quoted.sku,playMode==='age'?'selected-age':'lifespan-21');
    assert.equal(editor.page.data.priceLifespan,'¥49.90');assert.equal(editor.page.data.priceAge,'¥5.90');
    const request=quoted.generation;
    assert.deepEqual(Array.from(request.participantIds),subjectMode==='couple'?['consumer-1','partner']:['consumer-1']);
    assert.equal(request.targetAges.length,playMode==='age'?1:21);if(playMode==='age')assert.equal(request.targetAges[0],Number(targetAge));
    assert.equal(request.timelineProfile,`${playMode==='age'?'single-age':'lifespan-21'}${subjectMode==='couple'?'-couple':''}-v1`);
    if(subjectMode==='couple'){assert.deepEqual(Array.from(request.participantAges),[35,32]);assert.equal('imageUrl' in editor.page.onShareAppMessage(),false);assert.match(editor.page.onShareAppMessage().path,/participantId=partner/);}
  }
});

test("library opens wardrobe only from ready age photos and restores wardrobe jobs through their original source",async()=>{
  const f=loadLibraryPage(async(path,options)=>({data:options.data.query==='record.list'?[{id:'outfit-job',participantIds:['consumer-1'],data:{commandState:'failed',wardrobeEdit:{sourceRootCommandId:'original-root',targetAge:0}}}]:[]}));
  await f.page.load();assert.equal(f.page.data.items[0].creationKind,'wardrobe');
  await f.page.openTimeline({currentTarget:{dataset:{id:'outfit-job'}}});assert.equal(f.navigations.at(-1).url,'/pages/wardrobe/index?rootId=original-root&age=0&commandId=outfit-job');
  f.page.setData({activeCommandId:'original-root',selectedNode:{status:'ready',targetAge:100},delivery:{creationKind:'age'}});f.page.changeClothes();assert.equal(f.navigations.at(-1).url,'/pages/wardrobe/index?rootId=original-root&age=100');
  const count=f.navigations.length;f.page.setData({selectedNode:{status:'failed',targetAge:100}});f.page.changeClothes();assert.equal(f.navigations.length,count);
  f.page.setData({selectedNode:{status:'ready',targetAge:100},delivery:{creationKind:'wardrobe'}});f.page.changeClothes();assert.equal(f.navigations.length,count);
});
test("editor rejects invalid single targets and incomplete couple before any request", async()=>{
  for(const delta of [{playMode:'age',targetAge:''},{playMode:'age',targetAge:'101'},{playMode:'age',targetAge:'3.5'},{subjectMode:'couple',partnerParticipantId:'consumer-1',partnerCurrentAge:'32'},{subjectMode:'couple',partnerParticipantId:'partner',partnerCurrentAge:''}]){
    let calls=0;const e=loadEditorPage(async()=>calls++);e.page.setData({assetId:'source',participantId:'consumer-1',currentAge:'35',consentAccepted:true,...delta});await e.page.generate();assert.equal(calls,0);assert.equal(e.page.data.error,'PARTICIPANT_OR_AGES_INVALID');
  }
});
