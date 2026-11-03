import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const hash = value => createHash("md5").update(value).digest("hex"); // Vendor profile identity, not an authentication digest.

export async function readAsarPackage(path) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size, prefix = Buffer.alloc(16);
    if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error("DEVTOOLS_ASAR_HEADER_INVALID");
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (jsonSize < 2 || jsonSize > 16 * 1024 * 1024 || headerSize < jsonSize + 8 || 8 + headerSize > size) throw new Error("DEVTOOLS_ASAR_HEADER_INVALID");
    const bytes = Buffer.alloc(jsonSize);
    if ((await file.read(bytes, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error("DEVTOOLS_ASAR_HEADER_INVALID");
    const entry = JSON.parse(bytes.toString()).files?.["package.json"];
    const length = Number(entry?.size), offset = Number(entry?.offset);
    if (!entry || entry.unpacked || !Number.isSafeInteger(length) || length < 2 || length > 1024 * 1024 || !Number.isSafeInteger(offset) || offset < 0 || 8 + headerSize + offset + length > size) throw new Error("DEVTOOLS_ASAR_PACKAGE_INVALID");
    const body = Buffer.alloc(length);
    if ((await file.read(body, 0, length, 8 + headerSize + offset)).bytesRead !== length) throw new Error("DEVTOOLS_ASAR_PACKAGE_INVALID");
    const metadata = JSON.parse(body.toString());
    if (metadata.name !== "微信开发者工具" || typeof metadata.version !== "string") throw new Error("DEVTOOLS_INSTALLATION_UNRECOGNIZED");
    return metadata;
  } finally { await file.close(); }
}

async function optionalText(path) {
  try { const info = await stat(path); if (!info.isFile() || info.size > 100) throw new Error("DEVTOOLS_SERVICE_FILE_INVALID"); return (await readFile(path, "utf8")).trim(); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function inspectInstallation({ installation = "/Applications/wechatwebdevtools.app", supportRoot = join(homedir(), "Library/Application Support") } = {}) {
  const app = await realpath(installation), asar = join(app, "Contents/Resources/app.asar");
  const metadata = await readAsarPackage(asar);
  const electron = metadata.main === "js/electron/main.js";
  if (!electron && metadata.main !== "index.html" && metadata.main !== "html/index.html") throw new Error("DEVTOOLS_RUNTIME_UNRECOGNIZED");
  const baseAppPath = electron ? asar : join(app, "Contents/MacOS");
  const root = join(supportRoot, metadata.name), profile = join(root, hash(baseAppPath), "Default");
  const status = await optionalText(join(profile, ".ide-status")), savedPort = await optionalText(join(profile, ".ide"));
  const legacyProfile = join(root, hash(join(app, "Contents/MacOS")), "Default");
  const legacyStatus = legacyProfile === profile ? null : await optionalText(join(legacyProfile, ".ide-status"));
  const port = savedPort && /^[1-9][0-9]{0,4}$/.test(savedPort) && Number(savedPort) <= 65535 ? Number(savedPort) : null;
  return { installation: app, version: metadata.version, runtime: electron ? "electron" : "nwjs", baseAppPath, profile,
    cli: join(app, "Contents/MacOS/cli"), serviceStatus: status, port, legacyProfile, legacyServiceStatus: legacyStatus,
    readiness: status === null ? "CURRENT_PROFILE_SERVICE_RECORD_MISSING" : status === "Off" ? "CURRENT_PROFILE_SERVICE_DISABLED" : status !== "On" ? "CURRENT_PROFILE_SERVICE_STATUS_INVALID" : port === null ? "CURRENT_PROFILE_PORT_INVALID" : "LISTENER_VERIFICATION_REQUIRED" };
}

export async function verifyListener(report) {
  if (report.readiness !== "LISTENER_VERIFICATION_REQUIRED") throw new Error(report.readiness);
  let stdout;
  try { ({ stdout } = await execute("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${report.port}`, "-sTCP:LISTEN"], { timeout: 5000, maxBuffer: 65536 })); }
  catch (error) { if (error.code === 1) throw new Error("DEVTOOLS_SAVED_PORT_NOT_LISTENING"); throw error; }
  const pids = [...new Set(stdout.trim().split(/\s+/).map(Number))];
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0) throw new Error("DEVTOOLS_LISTENER_IDENTITY_UNCERTAIN");
  const { stdout: command } = await execute("/bin/ps", ["-p", String(pids[0]), "-o", "comm="], { timeout: 5000, maxBuffer: 65536 });
  const binary = await realpath(command.trim());
  const expected = report.runtime === "electron" ? "Electron" : "wechatwebdevtools";
  if (binary !== join(report.installation, "Contents/MacOS", expected)) throw new Error("DEVTOOLS_PORT_OWNED_BY_OTHER_PROCESS");
  return { pid: pids[0], binary, port: report.port };
}

export async function prepareAuto({ installation, supportRoot, project, autoPort = 9420 }) {
  if (process.platform !== "darwin") throw new Error("DEVTOOLS_MACOS_REQUIRED");
  if (!Number.isInteger(autoPort) || autoPort < 1 || autoPort > 65535) throw new Error("DEVTOOLS_AUTO_PORT_INVALID");
  const report = await inspectInstallation({ installation, supportRoot });
  const listener = await verifyListener(report), directory = await realpath(project);
  const config = JSON.parse(await readFile(join(directory, "project.config.json"), "utf8"));
  if (config.compileType !== "miniprogram") throw new Error("DEVTOOLS_MINIPROGRAM_PROJECT_REQUIRED");
  return { report, listener, command: report.cli, args: ["--port", String(report.port), "auto", "--project", directory, "--auto-port", String(autoPort)],
    environment: { ...process.env, ELECTRON_BASE_APP_PATH: report.baseAppPath } };
}

async function main() {
  const { parseArgs } = await import("node:util");
  const { values } = parseArgs({ options: { installation: { type: "string" }, project: { type: "string" }, "auto-port": { type: "string", default: "9420" }, auto: { type: "boolean", default: false } } });
  const report = await inspectInstallation({ installation: values.installation });
  console.log(JSON.stringify(report, null, 2));
  if (!values.auto) { if (report.readiness !== "LISTENER_VERIFICATION_REQUIRED") process.exitCode = 2; else console.log(JSON.stringify(await verifyListener(report))); return; }
  if (!values.project) throw new Error("DEVTOOLS_PROJECT_REQUIRED");
  const prepared = await prepareAuto({ installation: values.installation, project: values.project, autoPort: Number(values["auto-port"]) });
  console.log(JSON.stringify({ listener: prepared.listener, command: prepared.command, args: prepared.args, pathBinding: prepared.report.baseAppPath }));
  const child = spawn(prepared.command, prepared.args, { env: prepared.environment, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (!Number.isInteger(code)) throw new Error("DEVTOOLS_CLI_TERMINATED_WITHOUT_EXIT");
  process.exitCode = code;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
