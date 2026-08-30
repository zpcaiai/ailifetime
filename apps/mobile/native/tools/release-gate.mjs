import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLICATION_IDS = ["com.ailifetime.mobile", "com.ailifetime.mobile.test"];

export function evaluateReleaseEvidence(options = {}) {
  const root = resolve(options.root ?? ROOT);
  const now = options.now ?? new Date();
  const commit = options.commit ?? git(root, ["rev-parse", "HEAD"]);
  const version = JSON.parse(readFileSync(resolve(root, "store/release-metadata.json"), "utf8")).version;
  const blockers = [];
  if (options.clean !== true && git(root, ["status", "--porcelain"]) !== "") blockers.push("GIT_CHECKOUT_NOT_CLEAN");
  const device = readEvidence(root, options.devicePath ?? process.env.MOBILE_DEVICE_EVIDENCE_PATH, "DEVICE_EVIDENCE", blockers);
  const store = readEvidence(root, options.storePath ?? process.env.MOBILE_STORE_PROVIDER_RECEIPT_PATH, "STORE_PROVIDER_EVIDENCE", blockers);
  if (device !== null) validateDevice(device, commit, version, now, blockers);
  if (store !== null) validateStore(store, commit, version, now, blockers);
  return Object.freeze({
    schemaVersion: "ltm.mobile.release-gate.v1", commit, version,
    codeReady: blockers.length === 0, productionRelease: blockers.length === 0 ? "CANDIDATE_READY" : "EVIDENCE_PENDING",
    externalCertification: "NOT_CERTIFIED", blockers: Object.freeze(blockers),
  });
}

function readEvidence(root, input, label, blockers) {
  if (typeof input !== "string" || input === "") { blockers.push(`${label}_PENDING`); return null; }
  try {
    if (input !== input.trim() || isAbsolute(input) || !/^evidence\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\.json$/.test(input) || input.split("/").includes("..")) throw new Error("PATH");
    const candidate = resolve(root, input);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 262_144) throw new Error("FILE");
    const resolved = realpathSync(candidate);
    if (relative(realpathSync(resolve(root, "evidence")), resolved).startsWith("..")) throw new Error("ESCAPE");
    const raw = readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    if (JSON.stringify(parsed) !== raw) throw new Error("NONCANONICAL");
    return parsed;
  } catch { blockers.push(`${label}_INVALID`); return null; }
}

function validateDevice(value, commit, version, now, blockers) {
  if (!exact(value, ["schemaVersion", "commit", "version", "applicationIds", "checks", "metrics", "deviceRuns", "independentAuthority", "issuedAt", "expiresAt"]) ||
      value.schemaVersion !== "ltm.mobile.device-evidence.v1" || value.commit !== commit || value.version !== version ||
      !sameIds(value.applicationIds) || !exact(value.checks, ["unit", "integration", "device", "visual", "accessibility", "security", "privacy", "iap", "coldStart"]) ||
      Object.values(value.checks).some((passed) => passed !== true) || !exact(value.deviceRuns, ["android", "ios"]) ||
      !Number.isSafeInteger(value.deviceRuns.android) || value.deviceRuns.android < 1 || !Number.isSafeInteger(value.deviceRuns.ios) || value.deviceRuns.ios < 1 ||
      !exact(value.metrics, ["crashFreeRate", "anrRate", "coldStartP95Ms"]) || value.metrics.crashFreeRate < 0.995 || value.metrics.anrRate > 0.0047 || value.metrics.coldStartP95Ms > 2500 ||
      !reference(value.independentAuthority) || !lifetime(value, now)) blockers.push("DEVICE_EVIDENCE_BINDING_INVALID");
}

function validateStore(value, commit, version, now, blockers) {
  if (!exact(value, ["schemaVersion", "commit", "version", "applicationIds", "providers", "issuedAt", "expiresAt"]) ||
      value.schemaVersion !== "ltm.mobile.store-provider-evidence.v1" || value.commit !== commit || value.version !== version || !sameIds(value.applicationIds) ||
      !exact(value.providers, ["apple", "google"]) || !provider(value.providers.apple, "apple") || !provider(value.providers.google, "google") || !lifetime(value, now)) {
    blockers.push("STORE_PROVIDER_EVIDENCE_BINDING_INVALID");
  }
}

function provider(value, name) {
  return exact(value, ["provider", "state", "providerEvidenceId", "acceptedAt"]) && value.provider === name && value.state === "accepted" &&
    reference(value.providerEvidenceId) && Number.isFinite(Date.parse(value.acceptedAt));
}
function lifetime(value, now) {
  const issued = Date.parse(value.issuedAt); const expires = Date.parse(value.expiresAt); const current = now.getTime();
  return Number.isFinite(issued) && Number.isFinite(expires) && issued <= current + 60_000 && expires > current && expires - issued <= 7 * 86_400_000;
}
function sameIds(value) { return Array.isArray(value) && value.length === APPLICATION_IDS.length && APPLICATION_IDS.every((id) => value.includes(id)); }
function reference(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{31,511}$/.test(value); }
function exact(value, keys) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function git(root, args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = evaluateReleaseEvidence();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.codeReady) process.exitCode = 2;
}
