import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const RELEASE_ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(RELEASE_ROOT, "..");

export function validateReleaseEnvironment(environment = process.env, options = {}) {
  const projectRoot = realpathSync(options.projectRoot ?? PROJECT_ROOT);
  const appid = environment.LTM_WECHAT_APP_ID;
  if (typeof appid !== "string" || !/^wx[0-9a-f]{16}$/.test(appid) || appid === "wx0000000000000000") throw new Error("PRODUCTION_APP_ID_REQUIRED");
  const keyInput = environment.LTM_WECHAT_PRIVATE_KEY_PATH;
  if (typeof keyInput !== "string" || keyInput !== keyInput.trim() || !isAbsolute(keyInput)) throw new Error("PRIVATE_KEY_ABSOLUTE_PATH_REQUIRED");
  const stat = lstatSync(keyInput);
  const privateKeyPath = realpathSync(keyInput);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 128 || stat.size > 32_768 || (stat.mode & 0o077) !== 0 || !relative(projectRoot, privateKeyPath).startsWith("..")) {
    throw new Error("PRIVATE_KEY_FILE_UNSAFE");
  }
  const version = environment.LTM_WECHAT_VERSION;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("RELEASE_VERSION_REQUIRED");
  const description = environment.LTM_WECHAT_RELEASE_DESCRIPTION;
  if (typeof description !== "string" || description !== description.trim() || description.length < 8 || description.length > 120 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw new Error("RELEASE_DESCRIPTION_REQUIRED");
  }
  return Object.freeze({ appid, privateKeyPath, version, description, projectRoot });
}

export async function runRelease(mode, environment = process.env, dependencies = {}) {
  if (mode !== "preview" && mode !== "upload") throw new Error("RELEASE_MODE_INVALID");
  const config = validateReleaseEnvironment(environment, dependencies);
  const git = dependencies.git ?? ((args) => execFileSync("git", ["-C", config.projectRoot, ...args], { encoding: "utf8" }).trim());
  const commit = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(commit) || git(["status", "--porcelain"]) !== "") throw new Error("RELEASE_CHECKOUT_NOT_CLEAN");
  const ci = dependencies.ci ?? (await import("miniprogram-ci")).default;
  const project = new ci.Project({ appid: config.appid, type: "miniProgram", projectPath: config.projectRoot, privateKeyPath: config.privateKeyPath, ignores: ["node_modules/**/*", "dist/**/*", "release/**/*", "tools/**/*"] });
  if (mode === "preview") {
    await ci.preview({ project, desc: config.description, setting: secureSetting(), qrcodeFormat: "terminal", pagePath: "pages/home/index", searchQuery: "releaseCandidate=1" });
  } else {
    await ci.upload({ project, version: config.version, desc: config.description, setting: secureSetting(), robot: 1 });
  }
  return Object.freeze({ schemaVersion: "ltm.wechat.provider-operation.v1", mode, appid: config.appid, version: config.version, commit, providerOperation: `${mode}_completed`, merchantEvidence: "EVIDENCE_PENDING", deviceEvidence: "EVIDENCE_PENDING", externalCertification: "NOT_CERTIFIED" });
}

function secureSetting() { return { es6: true, es7: true, minify: true, codeProtect: true, autoPrefixWXSS: true, minifyWXML: true, minifyWXSS: true, minifyJS: true }; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  runRelease(mode).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "WECHAT_RELEASE_FAILED"}\n`); process.exitCode = 1;
  });
}
