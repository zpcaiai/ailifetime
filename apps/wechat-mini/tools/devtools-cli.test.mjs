import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { inspectInstallation, readAsarPackage, verifyListener } from "./devtools-cli.mjs";

async function fixture(action) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ltm-cli-profile-")));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function installation(root, main = "js/electron/main.js") {
  const app = join(root, "Wechat Devtools.app"), asar = join(app, "Contents/Resources/app.asar"), supportRoot = join(root, "support");
  await mkdir(join(app, "Contents/Resources"), { recursive: true });
  const body = Buffer.from(JSON.stringify({ name: "微信开发者工具", version: "2.02.2608080", main }));
  const header = Buffer.from(JSON.stringify({ files: { "package.json": { size: body.length, offset: "0" } } }));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length + 4, 8); prefix.writeUInt32LE(header.length, 12);
  await writeFile(asar, Buffer.concat([prefix, header, body]));
  const profile = base => join(supportRoot, "微信开发者工具", createHash("md5").update(base).digest("hex"), "Default");
  return { installation: app, supportRoot, asar, current: profile(asar), legacy: profile(join(app, "Contents/MacOS")) };
}
test("Electron configuration uses its ASAR installation hash; legacy On never enables current runtime", () => fixture(async root => {
  const f = await installation(root); await mkdir(f.legacy, { recursive: true }); await writeFile(join(f.legacy, ".ide-status"), "On"); await writeFile(join(f.legacy, ".ide"), "18176");
  const report = await inspectInstallation(f); assert.equal(report.profile, f.current); assert.equal(report.version, "2.02.2608080"); assert.equal(report.legacyServiceStatus, "On"); assert.equal(report.serviceStatus, null); assert.equal(report.readiness, "CURRENT_PROFILE_SERVICE_RECORD_MISSING");
  await assert.rejects(verifyListener(report), /CURRENT_PROFILE_SERVICE_RECORD_MISSING/);
  assert.equal(await readFile(join(f.legacy, ".ide-status"), "utf8"), "On");
}));
test("current profile On still requires a canonical valid port and live matching listener", () => fixture(async root => {
  const f = await installation(root); await mkdir(f.current, { recursive: true }); await writeFile(join(f.current, ".ide-status"), "On");
  for (const port of ["", "-1", "65536", "123abc", "0", "9420\nmalformed"]) {
    await writeFile(join(f.current, ".ide"), port); assert.equal((await inspectInstallation(f)).readiness, "CURRENT_PROFILE_PORT_INVALID");
  }
  await writeFile(join(f.current, ".ide"), "9420"); const report = await inspectInstallation(f); assert.equal(report.readiness, "LISTENER_VERIFICATION_REQUIRED"); assert.equal(report.port, 9420); assert.equal(report.baseAppPath, f.asar);
}));
test("NW profile remains MacOS-based and unknown runtimes fail closed", () => fixture(async root => {
  const f = await installation(root, "index.html"); assert.equal((await inspectInstallation(f)).profile, f.legacy);
  const unknown = await installation(root, "unknown.js"); await assert.rejects(inspectInstallation(unknown), /RUNTIME_UNRECOGNIZED/);
}));
test("ASAR reader rejects corrupt and oversized metadata instead of deriving an arbitrary profile", () => fixture(async root => {
  const f = await installation(root); assert.equal((await readAsarPackage(f.asar)).name, "微信开发者工具");
  await writeFile(f.asar, Buffer.alloc(16)); await assert.rejects(readAsarPackage(f.asar), /HEADER_INVALID/);
  const bad = Buffer.alloc(16); bad.writeUInt32LE(4); bad.writeUInt32LE(32*1024*1024,12); await writeFile(f.asar,bad); await assert.rejects(readAsarPackage(f.asar), /HEADER_INVALID/);
}));
