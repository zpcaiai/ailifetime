#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runDast } from "../security/scanners/dast.mjs";
import { stableJson } from "../security/lib/canonical.mjs";

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parse(argv);
  const authorization = options["authorization-file"] === undefined
    ? undefined
    : JSON.parse(readFileSync(resolve(options["authorization-file"]), "utf8"));
  const report = await runDast({
    baseUrl: options["base-url"] ?? "http://127.0.0.1:8080/",
    primaryToken: environment.LTM_DAST_PRIMARY_TOKEN,
    secondaryToken: environment.LTM_DAST_SECONDARY_TOKEN,
    primaryTenantId: options["primary-tenant"] ?? "tenant-dast-a",
    profile: options.profile ?? "local",
    authorization,
  });
  if (options.output !== undefined) {
    const path = resolve(options.output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stableJson(report), { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, targetOrigin: report.targetOrigin, summary: report.summary, coveredCategories: report.coveredCategories })}\n`);
  for (const probe of report.probes.filter((item) => item.status === "FAIL")) process.stderr.write(`SECURITY_DAST ${probe.category} ${probe.name}: ${probe.error}\n`);
  if (report.status !== "PASS") process.exitCode = 1;
  return report;
}

function parse(argv) {
  const result = {};
  for (const item of argv) {
    if (!item.startsWith("--") || !item.includes("=")) throw new Error(`invalid argument: ${item}`);
    const split = item.indexOf("=");
    result[item.slice(2, split)] = item.slice(split + 1);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`SECURITY_DAST ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
