import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMiniProgram } from "../../wechat-mini/tools/validate-miniprogram.mjs";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const XHS_MINI_ROOT = resolve(CURRENT_DIR, "..");
const WECHAT_MINI_ROOT = resolve(XHS_MINI_ROOT, "../wechat-mini");
const MAX_MAIN_PACKAGE_BYTES = 2 * 1024 * 1024; // 2 MiB

export class LaunchReadinessError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "LaunchReadinessError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LaunchReadinessError(code, message);
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    fail("FILE_MISSING", filePath);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    fail("JSON_INVALID", `${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function computeDirectoryBytes(dirPath) {
  if (!existsSync(dirPath)) {
    fail("BUNDLE_DIR_MISSING", dirPath);
  }
  let total = 0;
  let files = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
        files += 1;
      }
    }
  }
  return { totalBytes: total, fileCount: files };
}

export function validateDualMiniProgramLaunchReadiness(options = {}) {
  const xhsRoot = options.xhsRoot ?? XHS_MINI_ROOT;
  const wechatRoot = options.wechatRoot ?? WECHAT_MINI_ROOT;
  const release = options.release === true || process.env.LTM_MINIPROGRAM_RELEASE === "1";

  // 1. Validate Native WeChat Mini-Program (apps/wechat-mini)
  const nativeWechatReport = validateMiniProgram(wechatRoot, {
    release,
    appId: options.wechatAppId ?? process.env.LTM_WECHAT_APP_ID,
  });

  // 2. Validate uni-app source manifest.json & .env.production.example
  const manifestPath = join(xhsRoot, "src/manifest.json");
  const manifest = readJson(manifestPath);
  if (manifest["mp-weixin"]?.__usePrivacyCheck__ !== true) {
    fail("MP_WEIXIN_PRIVACY_CHECK_MISSING", "src/manifest.json mp-weixin.__usePrivacyCheck__ must be true");
  }
  if (manifest["mp-weixin"]?.lazyCodeLoading !== "requiredComponents") {
    fail("MP_WEIXIN_LAZY_LOADING_MISSING", "src/manifest.json mp-weixin.lazyCodeLoading must be requiredComponents");
  }
  if (!manifest["mp-weixin"]?.permission?.["scope.writePhotosAlbum"]?.desc) {
    fail("MP_WEIXIN_ALBUM_PERMISSION_DESC_MISSING", "mp-weixin must declare scope.writePhotosAlbum desc");
  }
  if (!manifest["mp-xhs"]?.permission?.["scope.writePhotosAlbum"]?.desc) {
    fail("MP_XHS_ALBUM_PERMISSION_DESC_MISSING", "mp-xhs must declare scope.writePhotosAlbum desc");
  }
  if (!existsSync(join(xhsRoot, ".env.production.example"))) {
    fail("ENV_PRODUCTION_TEMPLATE_MISSING", "apps/xhs-mini/.env.production.example is required");
  }

  // 3. Validate compiled mp-weixin bundle (dist/build/mp-weixin)
  const mpWeixinDir = join(xhsRoot, "dist/build/mp-weixin");
  const mpWeixinApp = readJson(join(mpWeixinDir, "app.json"));
  const mpWeixinProject = readJson(join(mpWeixinDir, "project.config.json"));
  if (mpWeixinApp.__usePrivacyCheck__ !== true) {
    fail("COMPILED_WEIXIN_PRIVACY_CHECK_MISSING", "dist/build/mp-weixin/app.json must include __usePrivacyCheck__: true");
  }
  if (mpWeixinProject.setting?.urlCheck !== true || mpWeixinProject.setting?.minified !== true) {
    fail("COMPILED_WEIXIN_SETTING_INVALID", "dist/build/mp-weixin/project.config.json must enforce urlCheck and minified");
  }
  for (const page of mpWeixinApp.pages || []) {
    for (const ext of [".js", ".json", ".wxml", ".wxss"]) {
      if (!existsSync(join(mpWeixinDir, `${page}${ext}`))) {
        fail("COMPILED_WEIXIN_PAGE_MISSING", `${page}${ext}`);
      }
    }
  }
  const mpWeixinStats = computeDirectoryBytes(mpWeixinDir);
  if (mpWeixinStats.totalBytes > MAX_MAIN_PACKAGE_BYTES) {
    fail("MP_WEIXIN_PACKAGE_TOO_LARGE", `${mpWeixinStats.totalBytes} > ${MAX_MAIN_PACKAGE_BYTES}`);
  }

  // 4. Validate compiled mp-xhs bundle (dist/build/mp-xhs)
  const mpXhsDir = join(xhsRoot, "dist/build/mp-xhs");
  const mpXhsApp = readJson(join(mpXhsDir, "app.json"));
  const mpXhsProject = readJson(join(mpXhsDir, "project.config.json"));
  if (mpXhsProject.setting?.urlCheck !== true || mpXhsProject.setting?.minified !== true) {
    fail("COMPILED_XHS_SETTING_INVALID", "dist/build/mp-xhs/project.config.json must enforce urlCheck and minified");
  }
  for (const page of mpXhsApp.pages || []) {
    for (const ext of [".js", ".json", ".xhsml", ".css"]) {
      if (!existsSync(join(mpXhsDir, `${page}${ext}`))) {
        fail("COMPILED_XHS_PAGE_MISSING", `${page}${ext}`);
      }
    }
  }
  const mpXhsStats = computeDirectoryBytes(mpXhsDir);
  if (mpXhsStats.totalBytes > MAX_MAIN_PACKAGE_BYTES) {
    fail("MP_XHS_PACKAGE_TOO_LARGE", `${mpXhsStats.totalBytes} > ${MAX_MAIN_PACKAGE_BYTES}`);
  }

  // 5. Verify TimeCapsule 20x5 catalog, GB 45438-2025 dual labels, and security guards in compiled bundles
  for (const [bundleLabel, dir] of [
    ["mp-weixin", mpWeixinDir],
    ["mp-xhs", mpXhsDir],
  ]) {
    const apiJs = readFileSync(join(dir, "services/api.js"), "utf8");
    const platformJs = readFileSync(join(dir, "utils/xhs-platform.js"), "utf8");
    const studioJs = readFileSync(join(dir, "pages/studio/index.js"), "utf8");
    const combined = `${apiJs}\n${platformJs}\n${studioJs}`;
    for (const requiredToken of [
      "life_0_100",
      "personal_intro",
      "PNG:iTXt:AIGeneratedContent",
      "WEBP:RIFF:AIGC",
      "PRODUCTION_API_ORIGIN_INVALID",
      "native_payment_accepted_pending_server_verification",
      "/v1/timecapsule/cards/render-export",
    ]) {
      if (!combined.includes(requiredToken)) {
        fail("BUNDLE_CONTRACT_TOKEN_MISSING", `${bundleLabel} missing required token: ${requiredToken}`);
      }
    }
  }

  // 6. When running in strict store-submission release mode, verify production AppIDs & HTTPS API origin
  if (release) {
    const xhsAppId = options.xhsAppId ?? process.env.LTM_XHS_APP_ID ?? mpXhsProject.appid;
    if (typeof xhsAppId !== "string" || xhsAppId.trim().length < 8 || xhsAppId === "YOUR_XHS_MINI_APPID") {
      fail("PRODUCTION_XHS_APP_ID_REQUIRED", "set LTM_XHS_APP_ID to the enrolled Xiaohongshu mini-program app id");
    }
    const prodApiOrigin = options.productionApiOrigin ?? process.env.LTM_PRODUCTION_API_ORIGIN ?? "";
    if (
      typeof prodApiOrigin !== "string" ||
      !prodApiOrigin.startsWith("https://") ||
      prodApiOrigin.includes(".local") ||
      prodApiOrigin.includes("localhost") ||
      prodApiOrigin.includes("127.0.0.1")
    ) {
      fail("PRODUCTION_API_ORIGIN_REQUIRED", "set LTM_PRODUCTION_API_ORIGIN to an ICP-registered HTTPS origin");
    }
  }

  return Object.freeze({
    status: "READY_FOR_LAUNCH",
    mode: release ? "production-submission" : "prelaunch-verified",
    nativeWechatMini: nativeWechatReport,
    uniWeixinMini: {
      pages: mpWeixinApp.pages.length,
      files: mpWeixinStats.fileCount,
      totalBytes: mpWeixinStats.totalBytes,
      privacyCheckEnabled: mpWeixinApp.__usePrivacyCheck__ === true,
    },
    uniXhsMini: {
      pages: mpXhsApp.pages.length,
      files: mpXhsStats.fileCount,
      totalBytes: mpXhsStats.totalBytes,
      albumPermissionDeclared: Boolean(mpXhsApp.permission?.["scope.writePhotosAlbum"]?.desc),
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const releaseFlag = process.argv.includes("--release");
    const report = validateDualMiniProgramLaunchReadiness({ release: releaseFlag });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
