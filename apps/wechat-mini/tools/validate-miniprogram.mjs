import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_EXTENSIONS = [".js", ".json", ".wxml", ".wxss"];

export class MiniProgramValidationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "MiniProgramValidationError";
    this.code = code;
  }
}

export function validateMiniProgram(root = DEFAULT_ROOT, options = {}) {
  const project = json(root, "project.config.json");
  const programRoot = resolve(root, string(project.miniprogramRoot, "project.config.json miniprogramRoot"));
  const app = json(programRoot, "app.json");
  if (project.compileType !== "miniprogram") fail("PROJECT_TYPE_INVALID", "compileType must be miniprogram");
  if (project.setting?.urlCheck !== true) fail("DOMAIN_CHECK_DISABLED", "urlCheck must remain enabled");
  if (project.__usePrivacyCheck__ !== true) {
    fail("PRIVACY_PLATFORM_GATE_MISSING", "WeChat privacy checks are required");
  }
  // This compiler field declares only the address/location APIs. Media access
  // remains protected by requirePrivacyAuthorize and the privacy event handler.
  const declaredPrivateInfos = app.requiredPrivateInfos;
  const supportedPrivateInfos = new Set(["chooseAddress", "chooseLocation", "choosePoi", "getFuzzyLocation", "getLocation", "onLocationChange", "startLocationUpdate", "startLocationUpdateBackground"]);
  if (declaredPrivateInfos !== undefined && (!Array.isArray(declaredPrivateInfos) ||
      new Set(declaredPrivateInfos).size !== declaredPrivateInfos.length ||
      declaredPrivateInfos.some((name) => !supportedPrivateInfos.has(name)))) {
    fail("PRIVATE_INFO_DECLARATION_INVALID", "requiredPrivateInfos accepts only supported address/location interfaces");
  }
  if (!Array.isArray(app.pages) || app.pages.length < 4) fail("PAGES_INVALID", "app.json must declare product pages");
  const pageFiles = [];
  for (const page of app.pages) {
    const pagePath = string(page, "app.json page");
    if (pagePath.includes("..") || pagePath.startsWith("/")) fail("PAGE_PATH_INVALID", pagePath);
    for (const extension of PAGE_EXTENSIONS) {
      const relative = `${pagePath}${extension}`;
      required(programRoot, relative);
      pageFiles.push(relative);
    }
  }
  required(programRoot, "services/api.js");
  required(programRoot, "services/session.js");
  required(programRoot, "services/sha256.js");
  required(programRoot, "services/upload.js");
  required(programRoot, "services/policy.js");
  required(programRoot, "services/commerce.js");
  required(programRoot, "services/messaging.js");
  required(programRoot, "services/privacy.js");
  required(programRoot, "policies/age-transformation.js");
  required(programRoot, "policies/wardrobe.js");
  required(programRoot, "assets/wardrobe-invite.png");
  required(programRoot, "policies/sharing.js");
  required(programRoot, "sitemap.json");

  const javascript = ["app.js", ...pageFiles.filter((name) => name.endsWith(".js")),
    "services/api.js", "services/session.js", "services/sha256.js", "services/upload.js", "services/policy.js",
    "services/commerce.js", "services/messaging.js", "services/privacy.js"]
    .map((name) => read(programRoot, name)).join("\n");
  const templates = pageFiles.filter((name) => name.endsWith(".wxml"))
    .map((name) => read(programRoot, name)).join("\n");

  forbidden(javascript, /wx\.setStorageSync\s*\(/, "PERSISTENT_SESSION_FORBIDDEN", "tokens and sessions must remain memory-only");
  forbidden(javascript, /Authorization\s*:\s*["'`]Bearer\s+[^$]/, "HARDCODED_BEARER", "bearer tokens must come from the verified session");
  forbidden(javascript, /https?:\/\/(?!127\.0\.0\.1|localhost)[^\s"'`]+/g, "HARDCODED_REMOTE_ORIGIN", "remote origins must come from ext configuration");
  forbidden(javascript, /data\s*:\s*\{\s*operation\s*:/, "LEGACY_OPERATION_ENVELOPE", "commands and queries must use their typed envelope fields");
  forbidden(javascript, /evidenceHash\s*:/, "CLIENT_CONSENT_DIGEST_FORBIDDEN", "consent disclosure authority must remain server-side");

  requirePattern(javascript, /\/v1\/auth\/wechat\/session/, "WECHAT_AUTH_MISSING");
  requirePattern(javascript, /\/v1\/session/, "SERVER_SESSION_BINDING_MISSING");
  requirePattern(javascript, /bindServerProjection/, "SESSION_PROJECTION_BINDING_MISSING");
  requirePattern(javascript, /apiAllowedOrigins/, "PRODUCTION_ORIGIN_ALLOWLIST_MISSING");
  requirePattern(javascript, /PROTECTED_API_HEADER/, "PROTECTED_HEADER_GUARD_MISSING");
  requirePattern(javascript, /\/v1\/capabilities\/visible/, "POLICY_FETCH_MISSING");
  requirePattern(javascript, /requireCapabilities/, "CAPABILITY_POLICY_ENFORCEMENT_MISSING");
  requirePattern(javascript, /\/v1\/uploads/, "RESUMABLE_UPLOAD_MISSING");
  requirePattern(javascript, /Content-Range/, "UPLOAD_RANGE_MISSING");
  requirePattern(javascript, /UPLOAD_OFFSET_MISMATCH/, "UPLOAD_OFFSET_CHECK_MISSING");
  requirePattern(javascript, /digestAlgorithm:\s*["']sha256["']/, "UPLOAD_SHA256_MISSING");
  forbidden(javascript, /sha-?1/i, "UPLOAD_WEAK_DIGEST_FORBIDDEN", "whole-file uploads must use SHA-256 without a SHA-1 fallback");
  requirePattern(javascript, /share-grant\.get/, "SIGNED_TERMINAL_POLLING_MISSING");
  requirePattern(javascript, /share-grant\.list/, "DURABLE_SHARE_RESTORE_MISSING");
  requirePattern(javascript, /share-grant\.revoke/, "PROVIDER_SHARE_REVOCATION_MISSING");
  requirePattern(javascript, /providerOperationId/, "OPAQUE_RESULT_REFERENCE_MISSING");
  requirePattern(javascript, /wx\.requestPayment\s*\(/, "NATIVE_WECHAT_PAYMENT_MISSING");
  requirePattern(javascript, /native_payment_accepted_pending_server_verification/, "PAYMENT_SERVER_VERIFICATION_GATE_MISSING");
  requirePattern(javascript, /\/v1\/wechat\/payments/, "PAYMENT_TERMINAL_PROJECTION_MISSING");
  forbidden(javascript, /\/v1\/capabilities\/B71/, "CLIENT_B71_CALLBACK_FORBIDDEN", "B71 is a signed external callback and cannot be invoked by the Mini Program");
  forbidden(javascript, /data\s*:\s*\{\s*checkoutId\s*:[^}]{0,120}amountMinor/, "CLIENT_PAYMENT_PRICE_FORBIDDEN", "the server must resolve checkout price");
  requirePattern(javascript, /wx\.requestSubscribeMessage\s*\(/, "SUBSCRIPTION_MESSAGE_API_MISSING");
  requirePattern(javascript, /\/v1\/wechat\/subscription-authorizations/, "SUBSCRIPTION_SERVER_CONTRACT_MISSING");
  requirePattern(javascript, /wx\.openCustomerServiceChat\s*\(/, "CUSTOMER_SERVICE_API_MISSING");
  requirePattern(javascript, /wx\.onNeedPrivacyAuthorization\s*\(/, "PRIVACY_LISTENER_MISSING");
  requirePattern(javascript, /wx\.requirePrivacyAuthorize\s*\(/, "PRIVACY_PRECHECK_MISSING");
  forbidden(javascript, /success\s*:\s*\([^)]*\)\s*=>\s*[^\n]{0,120}(?:state\s*:\s*["']paid|entitlement)/, "NATIVE_PAYMENT_AUTHORITY_FORBIDDEN", "wx.requestPayment success cannot grant payment or entitlement");
  forbidden(javascript, /command\s*:\s*["']record\.delete["'][\s\S]{0,240}sharing\.export-commands/, "LOCAL_ONLY_SHARE_REVOCATION", "share revocation must use the provider command contract");
  requirePattern(templates, /wx:if="\{\{item\.shareReady\}\}"[^>]*bindtap="revoke"/, "REVOKE_VISIBILITY_GUARD_MISSING");
  requirePattern(javascript, /session\.clear\(\)/, "SESSION_CLEANUP_MISSING");
  requirePattern(templates, /AI/, "AI_DISCLOSURE_MISSING");
  requirePattern(templates, /授权/, "CONSENT_DISCLOSURE_MISSING");
  for (const policy of ["age-transformation", "sharing"]) {
    const source = read(programRoot, `policies/${policy}.js`);
    const policyVersion = /const version = "([A-Za-z0-9._:-]{1,128})";/.exec(source)?.[1];
    const policyText = /const text = "([^"]+)";/.exec(source)?.[1];
    if (policyVersion === undefined || policyText === undefined || policyText.trim().length < 20) {
      fail("CONSENT_POLICY_DISPLAY_INVALID", `${policy} consent must expose a versioned non-empty disclosure`);
    }
    forbidden(source, /evidenceHash/, "CLIENT_CONSENT_DIGEST_FORBIDDEN", "the server resolves the signed disclosure digest");
  }

  for (const relative of ["release/package.json", "release/metadata.json", "release/upload.mjs"]) required(root, relative);
  const releaseSource = read(root, "release/upload.mjs");
  const releaseMetadata = json(root, "release/metadata.json");
  requirePattern(releaseSource, /miniprogram-ci/, "MINIPROGRAM_CI_MISSING");
  requirePattern(releaseSource, /LTM_WECHAT_PRIVATE_KEY_PATH/, "RELEASE_PRIVATE_KEY_INJECTION_MISSING");
  requirePattern(releaseSource, /RELEASE_CHECKOUT_NOT_CLEAN/, "RELEASE_GIT_BINDING_MISSING");
  if (releaseMetadata.externalCertification !== "NOT_CERTIFIED" || releaseMetadata.merchantEvidence !== "EVIDENCE_PENDING" || releaseMetadata.deviceEvidence !== "EVIDENCE_PENDING") {
    fail("EXTERNAL_EVIDENCE_STATUS_INVALID", "external merchant, device and platform evidence must not be self-certified");
  }

  const release = options.release === true || process.env.LTM_WECHAT_RELEASE === "1";
  const configuredAppId = options.appId ?? process.env.LTM_WECHAT_APP_ID ?? project.appid;
  if (release && (!/^wx[0-9a-f]{16}$/.test(configuredAppId) || configuredAppId === "wx0000000000000000")) {
    fail("PRODUCTION_APP_ID_REQUIRED", "set LTM_WECHAT_APP_ID to the enrolled production mini-program app id");
  }
  return Object.freeze({ pages: app.pages.length, files: pageFiles.length + 15, release, appIdMode: release ? "production" : "development" });
}

function json(root, relative) {
  try { return JSON.parse(read(root, relative)); }
  catch (error) { fail("JSON_INVALID", `${relative}: ${error instanceof Error ? error.message : String(error)}`); }
}
function read(root, relative) {
  const path = join(root, relative);
  required(root, relative);
  return readFileSync(path, "utf8");
}
function required(root, relative) {
  if (!existsSync(join(root, relative))) fail("FILE_MISSING", relative);
}
function string(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail("VALUE_INVALID", `${label} must be a non-empty string`);
  return value;
}
function forbidden(source, pattern, code, message) {
  if (pattern.test(source)) fail(code, message);
}
function requirePattern(source, pattern, code) {
  if (!pattern.test(source)) fail(code, `required production control ${pattern} was not found`);
}
function fail(code, message) { throw new MiniProgramValidationError(code, message); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateMiniProgram();
    process.stdout.write(`WeChat mini-program validation passed (${result.pages} pages, ${result.files} files, ${result.appIdMode})\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
