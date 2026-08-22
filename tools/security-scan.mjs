#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scanRepository, toSarif } from "../security/scanners/static-scanner.mjs";
import { stableJson } from "../security/lib/canonical.mjs";

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const report = scanRepository({
    root: options.root ?? process.cwd(),
    threshold: options.threshold ?? "high",
    ...(one(options["audit-json"]) === undefined ? {} : { auditJson: readJson(one(options["audit-json"])) }),
    ...(one(options["secret-report"]) === undefined ? {} : { secretReport: readJson(one(options["secret-report"])) }),
    ...(one(options["codeql-sarif"]) === undefined ? {} : { codeqlSarif: readJson(one(options["codeql-sarif"])) }),
    ...(one(options["trivy-config"]) === undefined ? {} : { trivyConfigReport: readJson(one(options["trivy-config"])) }),
    trivyImageReports: values(options["trivy-image"]).map(readJson),
    expectedImageNames: values(options["expected-image"]),
    ...(one(options["dast-report"]) === undefined ? {} : { dastReport: readJson(one(options["dast-report"])) }),
    expectedImageCount: Number(one(options["expected-image-count"]) ?? 3),
  });
  if (one(options.output) !== undefined) write(one(options.output), stableJson(report));
  if (one(options.sarif) !== undefined) write(one(options.sarif), stableJson(toSarif(report)));
  process.stdout.write(`${JSON.stringify({ status: report.status, threshold: report.threshold, summary: report.summary, coverage: report.coverage })}\n`);
  if (report.status !== "PASS") {
    for (const item of report.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical")) {
      process.stderr.write(`SECURITY_SCAN ${item.severity.toUpperCase()} ${item.ruleId} ${item.file}:${item.line} ${item.message}\n`);
    }
    process.exitCode = report.status === "NOT_RUN" ? 2 : 1;
  }
  return report;
}

function parse(argv) {
  const result = {};
  for (const item of argv) {
    if (!item.startsWith("--") || !item.includes("=")) throw new Error(`invalid argument: ${item}`);
    const split = item.indexOf("=");
    const key = item.slice(2, split);
    const value = item.slice(split + 1);
    result[key] = result[key] === undefined ? value : [...values(result[key]), value];
  }
  return result;
}

function values(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function one(value) { const list = values(value); if (list.length > 1) throw new Error("argument may only be supplied once"); return list[0]; }
function readJson(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }

function write(path, content) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o600 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    process.stderr.write(`SECURITY_SCAN ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
