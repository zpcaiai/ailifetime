#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE_GLOB = [
  "skills/building-marketing-content-platform/references/B57-marketing-site-seo-landing-builder.md",
  "skills/building-marketing-content-platform/references/B58-headless-cms-editorial-workflow.md",
  "skills/building-marketing-content-platform/references/B59-consent-cmp-cookie-attribution.md",
  "skills/building-marketing-content-platform/references/B60-campaign-deeplink-utm-qr.md",
  "skills/building-marketing-content-platform/references/B61-social-sharing-og-ugc-media-kit.md",
  "skills/building-marketing-content-platform/references/B62-brand-trust-status-press-sales-assets.md",
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function safeFile(root, pathValue, label) {
  if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.length > 512 || isAbsolute(pathValue) || pathValue.includes("\\") || pathValue.split("/").some((part) => part === "" || part === "." || part === "..")) fail("TRACE_PATH_INVALID", `${label} is not a safe repository-relative path`);
  const target = resolve(root, pathValue);
  const escaped = relative(root, target);
  if (escaped === ".." || escaped.startsWith(`..${sep}`)) fail("TRACE_PATH_INVALID", `${label} escapes the repository`);
  if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) fail("TRACE_FILE_MISSING", `${label} does not identify a regular file`);
  return target;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("TRACE_SCHEMA_INVALID", `${label} fields do not match the closed schema`);
}

export function verifyPublicWebTrace(rootValue = SCRIPT_ROOT) {
  const root = resolve(rootValue);
  const tracePath = safeFile(root, "packages/public-web-platform/requirements.trace.json", "requirements trace");
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  exactKeys(trace, ["schemaVersion", "skill", "codeImplementationStatus", "productionCertificationStatus", "externalOnlyGates", "requirements"], "trace");
  if (trace.schemaVersion !== "ltm.public-web-requirements-trace.v1" || trace.skill !== "building-marketing-content-platform") fail("TRACE_SCHEMA_INVALID", "trace identity is invalid");
  if (trace.codeImplementationStatus !== "PASSED" || trace.productionCertificationStatus !== "NOT_CERTIFIED") fail("TRACE_STATUS_INVALID", "code and external certification states must remain distinct");
  if (!Array.isArray(trace.externalOnlyGates) || trace.externalOnlyGates.length < 4 || trace.externalOnlyGates.some((gate) => typeof gate !== "string" || gate.trim().length < 20)) fail("TRACE_EXTERNAL_GATES_INVALID", "external-only gates must be explicit");
  const canonical = new Set();
  for (const pathValue of REFERENCE_GLOB) {
    const body = readFileSync(safeFile(root, pathValue, "canonical reference"), "utf8");
    for (const match of body.matchAll(/\|\s*(B(?:57|58|59|60|61|62)-R\d{2})\s*\|/gu)) canonical.add(match[1]);
  }
  if (canonical.size !== 30) fail("TRACE_CANONICAL_INVALID", `expected 30 canonical requirements, found ${canonical.size}`);
  if (!Array.isArray(trace.requirements) || trace.requirements.length !== canonical.size) fail("TRACE_COVERAGE_INVALID", "trace requirement count does not match canonical requirements");
  const observed = new Set();
  for (const [index, item] of trace.requirements.entries()) {
    exactKeys(item, ["id", "sources", "symbols", "tests"], `requirements[${index}]`);
    if (!canonical.has(item.id) || observed.has(item.id)) fail("TRACE_COVERAGE_INVALID", `trace requirement ${item.id} is missing or duplicated`);
    observed.add(item.id);
    if (!Array.isArray(item.sources) || item.sources.length === 0 || !Array.isArray(item.symbols) || item.symbols.length === 0 || !Array.isArray(item.tests) || item.tests.length === 0) fail("TRACE_BINDING_INVALID", `${item.id} lacks source, symbol, or test bindings`);
    if (item.sources.some((pathValue) => pathValue.includes("packages/capabilities/") || pathValue.includes("capability-registry"))) fail("TRACE_DEDICATED_MODULE_REQUIRED", `${item.id} is bound only to a shared capability handler`);
    const sourceBodies = item.sources.map((pathValue) => readFileSync(safeFile(root, pathValue, `${item.id} source`), "utf8"));
    for (const symbol of item.symbols) {
      if (typeof symbol !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(symbol) || !sourceBodies.some((body) => body.includes(symbol))) fail("TRACE_SYMBOL_MISSING", `${item.id} symbol ${symbol} is not implemented in a bound source`);
    }
    for (const pathValue of item.tests) {
      const testBody = readFileSync(safeFile(root, pathValue, `${item.id} test`), "utf8");
      if (!testBody.includes(item.id)) fail("TRACE_TEST_MISSING", `${item.id} does not have an explicitly named targeted test`);
    }
  }
  for (const id of canonical) if (!observed.has(id)) fail("TRACE_COVERAGE_INVALID", `${id} is missing from trace`);
  return {
    schemaVersion: "ltm.public-web-trace-verification.v1",
    status: "PASS",
    skill: trace.skill,
    requirementCount: canonical.size,
    batches: ["B57", "B58", "B59", "B60", "B61", "B62"],
    codeImplementationStatus: trace.codeImplementationStatus,
    productionCertificationStatus: trace.productionCertificationStatus,
    externalOnlyGateCount: trace.externalOnlyGates.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(verifyPublicWebTrace())}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", code: error?.code ?? "UNEXPECTED", message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
