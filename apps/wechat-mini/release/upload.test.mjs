import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRelease, validateReleaseEnvironment } from "./upload.mjs";

function fixture(context) {
  const base = mkdtempSync(join(tmpdir(), "ltm-wechat-release-")); context.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project"); mkdirSync(root);
  const key = join(base, "private.key"); writeFileSync(key, "k".repeat(256)); chmodSync(key, 0o600);
  return { base, root, key, env: { LTM_WECHAT_APP_ID: "wx0123456789abcdef", LTM_WECHAT_PRIVATE_KEY_PATH: key, LTM_WECHAT_VERSION: "2.0.0", LTM_WECHAT_RELEASE_DESCRIPTION: "verified release candidate" } };
}

test("release invokes real miniprogram-ci upload while preserving external evidence status", async (context) => {
  const value = fixture(context); let upload;
  const ci = { Project: class { constructor(config) { this.config = config; } }, upload: async (input) => { upload = input; }, preview: async () => {} };
  const result = await runRelease("upload", value.env, { projectRoot: value.root, ci, git: (args) => args[0] === "rev-parse" ? "a".repeat(40) : "" });
  assert.equal(upload.project.config.appid, value.env.LTM_WECHAT_APP_ID); assert.equal(result.providerOperation, "upload_completed"); assert.equal(result.externalCertification, "NOT_CERTIFIED");
});

test("release rejects placeholder ids, repo keys, loose permissions and symlinks", (context) => {
  const value = fixture(context);
  assert.throws(() => validateReleaseEnvironment({ ...value.env, LTM_WECHAT_APP_ID: "touristappid" }, { projectRoot: value.root }), /PRODUCTION_APP_ID_REQUIRED/);
  chmodSync(value.key, 0o644); assert.throws(() => validateReleaseEnvironment(value.env, { projectRoot: value.root }), /PRIVATE_KEY_FILE_UNSAFE/);
  chmodSync(value.key, 0o600); const link = join(value.base, "link.key"); symlinkSync(value.key, link);
  assert.throws(() => validateReleaseEnvironment({ ...value.env, LTM_WECHAT_PRIVATE_KEY_PATH: link }, { projectRoot: value.root }), /PRIVATE_KEY_FILE_UNSAFE/);
});
