import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  LaunchReadinessError,
  validateDualMiniProgramLaunchReadiness,
} from "./validate-launch-readiness.mjs";

test("local validation covers the native WeChat source and both uni-app artifacts", () => {
  const report = validateDualMiniProgramLaunchReadiness({ release: false });
  assert.equal(report.status, "LOCAL_ARTIFACTS_VALIDATED");
  assert.equal(report.mode, "local");
  assert.equal(report.platformRelease, "NOT_CERTIFIED");
  assert.equal(report.nativeWechatMini.pages, 11);
  assert.equal(report.uniWeixinMini.pages, 4);
  assert.equal(report.uniWeixinMini.privacyCheckEnabled, true);
  assert.ok(report.uniWeixinMini.totalBytes > 10_000 && report.uniWeixinMini.totalBytes < 2 * 1024 * 1024);
  assert.equal(report.uniXhsMini.pages, 4);
  assert.equal(report.uniXhsMini.albumPermissionDeclared, true);
  assert.ok(report.uniXhsMini.totalBytes > 10_000 && report.uniXhsMini.totalBytes < 2 * 1024 * 1024);
});

test("release submission gate fails closed when production AppIDs or HTTPS API origins are missing", () => {
  assert.throws(
    () =>
      validateDualMiniProgramLaunchReadiness({
        release: true,
        wechatAppId: "wx1234567890abcdef",
        xhsAppId: "YOUR_XHS_MINI_APPID",
        productionApiOrigin: "https://api.ailifetime.cn",
      }),
    (err) => err instanceof LaunchReadinessError && err.code === "PRODUCTION_XHS_APP_ID_REQUIRED"
  );

  assert.throws(
    () =>
      validateDualMiniProgramLaunchReadiness({
        release: true,
        wechatAppId: "wx1234567890abcdef",
        xhsAppId: "xhs_live_987654321",
        productionApiOrigin: "https://api.sandbox.ailifetime.local",
      }),
    (err) => err instanceof LaunchReadinessError && err.code === "PRODUCTION_API_ORIGIN_REQUIRED"
  );
});

test("valid-looking release parameters cannot promote an artifact built with a different AppID", () => {
  assert.throws(() => validateDualMiniProgramLaunchReadiness({
    release: true,
    wechatAppId: "wx1234567890abcdef",
    xhsAppId: "xhs_live_987654321",
    productionApiOrigin: "https://api.ailifetime.cn",
  }), { code: "PRODUCTION_XHS_ARTIFACT_APP_ID_MISMATCH" });
});

test("credential-bearing, path-bearing and reserved URLs cannot satisfy release configuration", () => {
  for (const origin of ["https://token@api.product.cn", "https://api.product.cn/v1",
    "https://api.product.cn?key=secret", "https://api.product.cn#x", "https://api.product.cn:444",
    "https://api.product.test", "https://127.0.0.1"]) {
    assert.throws(() => validateDualMiniProgramLaunchReadiness({
      release: true,
      wechatAppId: "wx1234567890abcdef",
      xhsAppId: "xhs_live_987654321",
      productionApiOrigin: origin,
    }), { code: "PRODUCTION_API_ORIGIN_REQUIRED" });
  }
});

for (const platform of ["mp-xhs", "mp-weixin"]) {
  test(`${platform} built adapter rejects native login failure and preserves only real platform codes`, async () => {
    const exports = {};
    let nativeLogin;
    const vendor = { index: { login: handlers => nativeLogin(handlers) } };
    const source = readFileSync(new URL(`../dist/build/${platform}/utils/xhs-platform.js`, import.meta.url), "utf8");
    runInNewContext(source, {
      exports,
      require: path => {
        assert.equal(path, "../common/vendor.js");
        return vendor;
      },
    });
    const rejectExchange = () => assert.fail("invalid code must not be exchanged");
    nativeLogin = ({ fail }) => fail({ errMsg: "platform unavailable" });
    await assert.rejects(exports.exchangePlatformSession(rejectExchange), { message: "PLATFORM_LOGIN_FAILED" });
    for (const code of [undefined, "", "contains spaces"]) {
      nativeLogin = ({ success }) => success({ code });
      await assert.rejects(exports.exchangePlatformSession(rejectExchange), { message: "PLATFORM_LOGIN_CODE_INVALID" });
    }
    nativeLogin = ({ success }) => success({ code: "opaque-login-code" });
    const session = await exports.exchangePlatformSession(async request => {
      assert.deepEqual({ ...request }, { platform, js_code: "opaque-login-code" });
      return { platform, access_token: "fixture-test-session-token", expires_at: new Date(Date.now() + 60_000).toISOString() };
    });
    assert.equal(session.platform, platform);
    assert.equal(exports.requestNativeMiniProgramPayment, undefined);
    const share = exports.buildCompliantShareConfig({
      title: "我的 AI 人生胶片", path: "/pages/index/index", shareUrl: "https://share.product.cn/s/123",
      provenanceId: "prov-123",
    });
    assert.equal(share.title, "【AI艺术示意】我的 AI 人生胶片");
    if (platform === "mp-weixin") {
      assert.equal((await exports.ensurePlatformPrivacyAuthorized()).authorized, false);
    }
  });
}

test("the XHS cashier invokes the platform only for a bound, live checkout and never reports payment", async () => {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const ts = require("typescript");
  const source = readFileSync(new URL("../src/utils/xhs-platform.ts", import.meta.url), "utf8");
  const program = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  let call;
  const xhs = { requestOrderPayment(options) { assert.equal(this, xhs); call = options; } };
  runInNewContext(program, { exports, xhs, setTimeout, clearTimeout });
  const order = {
    id: "order_1", state: "awaiting-payment", amount_minor: 9900, currency: "CNY",
    xhs_custom_checkout: {
      order_id: "order_1", provider_order_id: "xhs_order_1", pay_token: "test_token",
      amount_minor: 9900, currency: "CNY", expires_at_unix: Math.floor(Date.now() / 1000) + 60,
      zfb_url: "https://cashier.example.cn/checkout?key=synthetic",
    },
  };
  const request = exports.requestXhsCustomPayment;
  for (const invalid of [
    { order_id: "different" }, { amount_minor: 1 }, { expires_at_unix: 1 },
    { zfb_url: "https://cashier.example.cn@unsafe.cn/" }, { zfb_url: "http://cashier.example.cn" },
    { zfb_url: undefined },
  ]) {
    await assert.rejects(request({ ...order, xhs_custom_checkout: { ...order.xhs_custom_checkout, ...invalid } }),
      { message: "XHS_CHECKOUT_INVALID" });
  }
  await assert.rejects(request({ ...order, state: "paid" }), { message: "XHS_CHECKOUT_INVALID" });
  assert.equal(call, undefined);
  const returned = request(order);
  assert.deepEqual({ ...call.orderInfo }, {
    orderId: "xhs_order_1", payToken: "test_token", payMethod: "third",
    zfbUrl: "https://cashier.example.cn/checkout?key=synthetic",
  });
  await assert.rejects(request(order), { message: "XHS_CASHIER_BUSY" });
  call.success({ success: true });
  assert.equal(await returned, "returned");
  const cancelled = request(order);
  call.fail({ errMsg: "requestOrderPayment:fail cancel" });
  assert.equal(await cancelled, "cancelled");
  const unknown = request(order);
  call.success({ success: false });
  assert.equal(await unknown, "unknown");
  xhs.requestOrderPayment = () => { throw new Error("internal provider details"); };
  assert.equal(await request(order), "unknown");
  delete xhs.requestOrderPayment;
  await assert.rejects(request(order), { message: "XHS_CASHIER_UNAVAILABLE" });
});

test("configured builds embed the target AppID and HTTPS origin without simulated sessions", { timeout: 150_000 }, async t => {
  const appRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "ltm-mini-production-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  copyFileSync(join(appRoot, "src", "manifest.json"), join(root, "src", "manifest.json"));
  copyFileSync(join(appRoot, ".env.production.example"), join(root, ".env.production.example"));

  const origin = "https://api.fixture.product.cn";
  const identityOrigin = "https://identity.fixture.product.cn";
  const xhsId = "1234567890abcdef12345678";
  const weixinId = "wx1234567890abcdef";
  const readJson = path => JSON.parse(readFileSync(path, "utf8"));
  for (const [platform, appId] of [["mp-xhs", xhsId], ["mp-weixin", weixinId]]) {
    const dir = join(root, "dist", "build", platform);
    execFileSync("pnpm", ["run", `build:${platform}`], {
      cwd: appRoot,
      timeout: 60_000,
      env: {
        ...process.env,
        UNI_OUTPUT_DIR: dir,
        VITE_SANDBOX_MODE: "false",
        VITE_API_BASE_URL: origin,
        VITE_XHS_IDENTITY_ORIGIN: identityOrigin,
        VITE_XHS_MINI_APPID: xhsId,
        VITE_WECHAT_MINI_APPID: weixinId,
      },
    });
    const api = readFileSync(join(dir, "services", "api.js"));
    assert.equal(readJson(join(dir, "project.config.json")).appid, appId);
    assert.deepEqual(readJson(join(dir, "release-build.json")), {
      version: 1, platform, appId, apiOrigin: origin,
      ...(platform === "mp-xhs" ? { identityOrigin } : {}),
      apiSha256: createHash("sha256").update(api).digest("hex"),
    });
    assert.ok(api.includes(JSON.stringify(origin)));
    assert.ok(!api.includes("st_sandbox_"));
    const extension = platform === "mp-xhs" ? "xhsml" : "wxml";
    const studio = readFileSync(join(dir, "pages", "studio", `index.${extension}`), "utf8");
    assert.ok(studio.includes("照片工坊暂未开放"));
    assert.ok(studio.includes("工坊演示使用模拟数据"));
  }

  const wechatId = readJson(join(appRoot, "..", "wechat-mini", "project.config.json")).appid;
  const options = { release: true, xhsRoot: root, wechatAppId: wechatId, xhsAppId: xhsId,
    productionApiOrigin: origin, xhsIdentityOrigin: identityOrigin };
  assert.throws(() => validateDualMiniProgramLaunchReadiness(options), { code: "PLATFORM_RELEASE_EVIDENCE_REQUIRED" });
  assert.throws(() => validateDualMiniProgramLaunchReadiness({ ...options, xhsIdentityOrigin: "https://other.fixture.product.cn" }),
    { code: "PRODUCTION_XHS_ARTIFACT_CONFIG_MISMATCH" });
  assert.throws(() => validateDualMiniProgramLaunchReadiness({ ...options, productionApiOrigin: "https://other.fixture.product.cn" }),
    { code: "PRODUCTION_XHS_ARTIFACT_CONFIG_MISMATCH" });
  const apiPath = join(root, "dist", "build", "mp-xhs", "services", "api.js");
  const pristine = readFileSync(apiPath);
  await verifyCompiledIdentityRequest(join(root, "dist", "build", "mp-xhs"), identityOrigin);
  writeFileSync(apiPath, Buffer.concat([pristine, Buffer.from("\n// fixture tamper\n")]));
  assert.throws(() => validateDualMiniProgramLaunchReadiness(options), { code: "PRODUCTION_XHS_ARTIFACT_CONFIG_MISMATCH" });
  await verifyCompiledOrderPage(join(root, "dist", "build", "mp-xhs"), t);
});

async function verifyCompiledIdentityRequest(dir, identityOrigin) {
  const sdk = {};
  const api = {};
  const requests = [];
  const vendor = { index: { request(options) {
    requests.push(options);
    options.success({ statusCode: 200, data: { platform: "mp-xhs" } });
  } } };
  runInNewContext(readFileSync(join(dir, "sdk/index.js"), "utf8"), { exports: sdk });
  runInNewContext(readFileSync(join(dir, "services/api.js"), "utf8"), {
    exports: api, require: path => path.includes("vendor") ? vendor : sdk,
  });
  api.setAccessToken("previous-business-access-token");
  await api.apiClient.exchangeMiniProgramSession({ platform: "mp-xhs", js_code: "one-use-fixture-code" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, identityOrigin + "/v1/mini-program/sessions");
  assert.equal(requests[0].header.Authorization, undefined);
  assert.equal(requests[0].data.js_code, "one-use-fixture-code");
}

async function verifyCompiledOrderPage(dir, t) {
  const lifecycle = {};
  const native = {
    createPage(page) { native.page = page; },
    requestOrderPayment(input) { native.cashier = input; },
  };
  t.after(() => native.cashier?.fail());
  const vendor = {
    defineComponent: page => page,
    _export_sfc: page => page,
    ref: value => ({ value }),
    unref: value => value,
    onLoad: handler => { lifecycle.load = handler; },
    onShow: handler => { lifecycle.show = handler; },
    onHide: handler => { lifecycle.hide = handler; },
    onUnload: handler => { lifecycle.unload = handler; },
    e: (...objects) => Object.assign({}, ...objects),
    o: handler => handler,
    t: value => value,
    index: { login: ({ success }) => success({ code: "native-fixture-code" }) },
  };
  const orderId = "order_review_1";
  let token;
  let state = "awaiting-payment";
  let queries = 0;
  const api = {
    IS_SANDBOX_MODE: false,
    getCurrentPlatformChannel: () => "mp-xhs",
    getLatestShareId: () => "",
    getTrackedShare: () => null,
    setAccessToken: value => { token = value; },
    apiClient: {
      async exchangeMiniProgramSession(body) {
        assert.deepEqual({ ...body }, { platform: "mp-xhs", js_code: "native-fixture-code" });
        return { platform: "mp-xhs", access_token: "fixture-test-session-token",
          expires_at: new Date(Date.now() + 60_000).toISOString() };
      },
      async getOrder(id) {
        assert.equal(id, orderId);
        queries++;
        if (!token) throw new Error("MINI_PROGRAM_LOGIN_REQUIRED");
        return {
          id, state, amount_minor: 9900, currency: "CNY", items: [],
          xhs_custom_checkout: {
            order_id: id, provider_order_id: "xhs_review_1", pay_token: "short-lived-fixture-token",
            amount_minor: 9900, currency: "CNY", expires_at_unix: Math.floor(Date.now() / 1000) + 60,
            zfb_url: "https://cashier.example.cn/pay",
          },
        };
      },
    },
  };
  const platform = {};
  runInNewContext(readFileSync(join(dir, "utils/xhs-platform.js"), "utf8"), {
    exports: platform, xhs: native, Error, setTimeout, clearTimeout, require: () => vendor,
  });
  runInNewContext(readFileSync(join(dir, "pages/profile/index.js"), "utf8"), {
    xhs: native, Error,
    require(path) {
      return {
        "../../common/vendor.js": vendor, "../../services/api.js": api, "../../utils/xhs-platform.js": platform,
      }[path];
    },
  });
  const render = native.page.setup();
  lifecycle.load({ order_id: orderId });
  lifecycle.show();
  await setImmediate();
  assert.equal(queries, 2);
  const template = readFileSync(join(dir, "pages/profile/index.xhsml"), "utf8");
  const payBinding = /bindtap="\{\{(\w+)\}\}"[^>]*>继续支付<\/button>/.exec(template)?.[1];
  assert.equal(typeof render()[payBinding], "function");
  const paying = render()[payBinding]();
  await setImmediate();
  assert.equal(queries, 3);
  assert.equal(native.cashier.orderInfo.orderId, "xhs_review_1");
  native.cashier.success({ success: true });
  await paying;
  assert.equal(queries, 4);
  assert.ok(Object.values(render()).includes("订单状态待确认，请稍后刷新"));
  assert.ok(!Object.values(render()).includes("paid"));
  assert.equal(render()[payBinding], undefined);
  state = "paid";
  lifecycle.show();
  await setImmediate();
  assert.equal(queries, 5);
  assert.ok(Object.values(render()).includes("paid"));
  lifecycle.hide();
  assert.ok(!Object.values(render()).includes("paid"));
}
