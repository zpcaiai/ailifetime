import test from "node:test";
import assert from "node:assert/strict";
import {
  LaunchReadinessError,
  validateDualMiniProgramLaunchReadiness,
} from "./validate-launch-readiness.mjs";

test("dual mini-program pre-launch readiness passes for native WeChat, uni mp-weixin, and uni mp-xhs", () => {
  const report = validateDualMiniProgramLaunchReadiness({ release: false });
  assert.equal(report.status, "READY_FOR_LAUNCH");
  assert.equal(report.mode, "prelaunch-verified");
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

test("release submission gate passes when valid production WeChat AppID, XHS AppID, and HTTPS origin are supplied", () => {
  const report = validateDualMiniProgramLaunchReadiness({
    release: true,
    wechatAppId: "wx1234567890abcdef",
    xhsAppId: "xhs_live_987654321",
    productionApiOrigin: "https://api.ailifetime.cn",
  });
  assert.equal(report.status, "READY_FOR_LAUNCH");
  assert.equal(report.mode, "production-submission");
  assert.equal(report.nativeWechatMini.appIdMode, "production");
});
