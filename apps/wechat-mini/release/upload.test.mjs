import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRelease, validateReleaseEnvironment } from "./upload.mjs";
import { configureApi } from "../tools/configure-api.mjs";

function fixture(context) {
  const base = mkdtempSync(join(tmpdir(), "ltm-wechat-release-")); context.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project"); mkdirSync(root);
  const appid = "wx0123456789abcdef";
  const project = { appid, compileType: "miniprogram", miniprogramRoot: "miniprogram/",
    setting: { urlCheck: true }, __usePrivacyCheck__: true };
  mkdirSync(join(root, "miniprogram"));
  writeFileSync(join(root, "project.config.json"), JSON.stringify(project));
  const key = join(base, "private.key"); writeFileSync(key, "k".repeat(256)); chmodSync(key, 0o600);
  return { base, root, key, env: { LTM_WECHAT_APP_ID: appid, LTM_WECHAT_PRIVATE_KEY_PATH: key, LTM_WECHAT_VERSION: "2.0.0", LTM_WECHAT_RELEASE_DESCRIPTION: "verified release candidate" } };
}

test("release passes a locally validated project to the upload boundary", async (context) => {
  const value = fixture(context); let upload;
  configureApi({ project: value.root, apiBaseUrl: "https://api.product.cn" });
  const ci = { Project: class { constructor(config) { this.config = config; } }, upload: async (input) => { upload = input; }, preview: async () => {} };
  const result = await runRelease("upload", value.env, { projectRoot: value.root, ci, git: (args) => args[0] === "rev-parse" ? "a".repeat(40) : "" });
  assert.equal(upload.project.config.appid, value.env.LTM_WECHAT_APP_ID); assert.equal(result.providerOperation, "upload_completed"); assert.equal(result.externalCertification, "NOT_CERTIFIED");
  assert.match(result.apiConfigurationSha256, /^[0-9a-f]{64}$/);
});

test("release refuses missing, mismatched, or unsafe API configuration before touching the provider", async context => {
  const value = fixture(context);
  const dependencies = {
    projectRoot: value.root,
    ci: { Project: class { constructor() { assert.fail("provider project must not be constructed"); } } },
    git: args => args[0] === "rev-parse" ? "a".repeat(40) : "",
  };
  await assert.rejects(runRelease("upload", value.env, dependencies), /RELEASE_API_CONFIGURATION_REQUIRED/);
  await assert.rejects(runRelease("preview", { ...value.env, LTM_WECHAT_APP_ID: "wx1123456789abcdef" }, dependencies),
    /RELEASE_PROJECT_APP_ID_MISMATCH/);
  const path = join(value.root, "miniprogram", "ext.json");
  symlinkSync(value.key, path);
  await assert.rejects(runRelease("upload", value.env, dependencies), /EXT_CONFIGURATION_UNSAFE/);
  rmSync(path);
  writeFileSync(path, JSON.stringify({ extEnable: true, extAppid: value.env.LTM_WECHAT_APP_ID,
    ext: { apiBaseUrl: "https://api.product.cn", apiAllowedOrigins: ["https://api.product.cn"], token: "test" } }));
  await assert.rejects(runRelease("upload", value.env, dependencies), /RELEASE_API_CONFIGURATION_UNEXPECTED_FIELDS/);
});

test("release rejects placeholder ids, repo keys, loose permissions and symlinks", (context) => {
  const value = fixture(context);
  assert.throws(() => validateReleaseEnvironment({ ...value.env, LTM_WECHAT_APP_ID: "touristappid" }, { projectRoot: value.root }), /PRODUCTION_APP_ID_REQUIRED/);
  chmodSync(value.key, 0o644); assert.throws(() => validateReleaseEnvironment(value.env, { projectRoot: value.root }), /PRIVATE_KEY_FILE_UNSAFE/);
  chmodSync(value.key, 0o600); const link = join(value.base, "link.key"); symlinkSync(value.key, link);
  assert.throws(() => validateReleaseEnvironment({ ...value.env, LTM_WECHAT_PRIVATE_KEY_PATH: link }, { projectRoot: value.root }), /PRIVATE_KEY_FILE_UNSAFE/);
});
