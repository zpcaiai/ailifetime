import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMiniProgram } from "../../wechat-mini/tools/validate-miniprogram.mjs";
import { probeApiReadiness } from "../../wechat-mini/tools/configure-api.mjs";

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

function isPublicHttpsOrigin(value) {
  if (typeof value !== "string" || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    return value === parsed.origin && parsed.protocol === "https:" && !parsed.port &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(parsed.hostname) &&
      !/\.(?:localhost|local|test|example|invalid)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

function validateArtifactBinding(dir, platform, appId, expectedOrigin, expectedIdentityOrigin) {
  const binding = readJson(join(dir, "release-build.json"));
  const api = readFileSync(join(dir, "services/api.js"));
  if (binding.version !== 1 || binding.platform !== platform || binding.appId !== appId ||
      !isPublicHttpsOrigin(binding.apiOrigin) || (expectedOrigin && binding.apiOrigin !== expectedOrigin) ||
      !api.includes(JSON.stringify(binding.apiOrigin)) || api.includes("st_sandbox_") ||
      !isPublicHttpsOrigin(binding.identityOrigin) || binding.identityOrigin !== expectedIdentityOrigin ||
      !api.includes(JSON.stringify(binding.identityOrigin)) ||
      binding.apiSha256 !== createHash("sha256").update(api).digest("hex")) {
    fail("PRODUCTION_XHS_ARTIFACT_CONFIG_MISMATCH", `${platform} build configuration does not match the artifact`);
  }
  return binding.apiSha256;
}

function validateXhsReleaseArtifact(dir, project, options) {
  const appId = options.xhsAppId ?? process.env.LTM_XHS_APP_ID;
  if (typeof appId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(appId) ||
      /placeholder|^your_|^tourist/i.test(appId)) {
    fail("PRODUCTION_XHS_APP_ID_REQUIRED", "set LTM_XHS_APP_ID to the enrolled Xiaohongshu mini-program app id");
  }
  const apiOrigin = options.productionApiOrigin ?? process.env.LTM_PRODUCTION_API_ORIGIN;
  if (!isPublicHttpsOrigin(apiOrigin)) {
    fail("PRODUCTION_API_ORIGIN_REQUIRED", "provide a canonical public HTTPS origin");
  }
  if (project.appid !== appId) {
    fail("PRODUCTION_XHS_ARTIFACT_APP_ID_MISMATCH", "the built Xiaohongshu project must embed the enrolled AppID");
  }
  if (project.setting?.urlCheck !== true || project.setting?.minified !== true) {
    fail("MP_XHS_BUILD_SETTINGS_INVALID", "URL checking and minification are required");
  }
  const identityOrigin = options.xhsIdentityOrigin ?? process.env.LTM_XHS_IDENTITY_ORIGIN;
  if (!isPublicHttpsOrigin(identityOrigin)) {
    fail("PRODUCTION_XHS_IDENTITY_ORIGIN_REQUIRED", "provide the enrolled identity broker HTTPS origin");
  }
  const apiSha256 = validateArtifactBinding(dir, "mp-xhs", appId, apiOrigin, identityOrigin);
  return { appId, apiOrigin, apiSha256 };
}

export async function preflightXhsExperience(options = {}, fetcher = globalThis.fetch) {
  const dir = join(options.xhsRoot ?? XHS_MINI_ROOT, "dist/build/mp-xhs");
  const projectPath = join(dir, "project.config.json");
  const candidate = validateXhsReleaseArtifact(dir, readJson(projectPath), options);
  const readiness = await probeApiReadiness(candidate.apiOrigin, fetcher);
  const checked = validateXhsReleaseArtifact(dir, readJson(projectPath), options);
  if (checked.apiSha256 !== candidate.apiSha256) {
    fail("EXPERIENCE_ARTIFACT_CHANGED", "the compiled API binding changed during the readiness check");
  }
  return Object.freeze({
    status: "EXPERIENCE_API_READY",
    platformRelease: "NOT_CERTIFIED",
    appId: candidate.appId,
    apiSha256: candidate.apiSha256,
    readiness,
  });
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

  // 5. Verify required integration references in the compiled bundles.
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
      "PRODUCTION_API_ORIGIN_INVALID",
      "/v1/timecapsule/cards/render-export",
    ]) {
      if (!combined.includes(requiredToken)) {
        fail("BUNDLE_CONTRACT_TOKEN_MISSING", `${bundleLabel} missing required token: ${requiredToken}`);
      }
    }
    if (combined.includes("native_payment_accepted_pending_server_verification")) {
      fail("UNVERIFIED_NATIVE_PAYMENT_CLAIM", `${bundleLabel} contains a local cashier acceptance receipt`);
    }
  }

  // 6. Release admission is stricter than local artifact validation.
  if (release) {
    validateXhsReleaseArtifact(mpXhsDir, mpXhsProject, options);
    const wechatAppId = options.wechatAppId ?? process.env.LTM_WECHAT_APP_ID;
    if (!wechatAppId || readJson(join(wechatRoot, "project.config.json")).appid !== wechatAppId) {
      fail("PRODUCTION_WECHAT_ARTIFACT_APP_ID_MISMATCH", "the native WeChat project must embed the enrolled AppID");
    }
    fail("PLATFORM_RELEASE_EVIDENCE_REQUIRED",
      "release admission requires verified live API binding, merchant capability, device evidence and platform review");
  }

  return Object.freeze({
    status: "LOCAL_ARTIFACTS_VALIDATED",
    mode: "local",
    platformRelease: "NOT_CERTIFIED",
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
    const experienceFlag = process.argv.includes("--experience");
    if (releaseFlag && experienceFlag) fail("VALIDATION_MODE_INVALID", "select one validation mode");
    const report = experienceFlag ? await preflightXhsExperience() : validateDualMiniProgramLaunchReadiness({ release: releaseFlag });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
