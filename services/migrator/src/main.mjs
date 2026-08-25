#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresMigrationError, runPostgresMigrations } from "./runner.mjs";

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const profile = scalar(options.profile) ?? "production";
  const report = await runPostgresMigrations({
    connectionString: scalar(options.url) ?? environment.LTM_MIGRATOR_DATABASE_URL,
    manifestPath: resolve(scalar(options.manifest) ?? resolve(root, "infra/postgres/migrations/manifest.json")),
    profile,
    allowInsecureLoopback: profile === "test" && scalar(options["allow-insecure-loopback"]) === "true",
    ...(scalar(options["connection-timeout-ms"]) === undefined ? {} : { connectionTimeoutMillis: scalar(options["connection-timeout-ms"]) }),
    ...(scalar(options["statement-timeout-ms"]) === undefined ? {} : { statementTimeoutMillis: scalar(options["statement-timeout-ms"]) }),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = scalar(options.output);
  if (output !== undefined) {
    const path = resolve(output);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, serialized, { mode: 0o600, flag: "wx" });
  }
  process.stdout.write(serialized);
  return report;
}

function parseArguments(argv) {
  const result = {};
  for (const argument of argv) {
    if (!argument.startsWith("--") || !argument.includes("=")) throw new PostgresMigrationError("MIGRATOR_ARGUMENT_INVALID", `Invalid argument ${argument}`);
    const split = argument.indexOf("=");
    const key = argument.slice(2, split);
    const value = argument.slice(split + 1);
    if (key === "" || value === "" || result[key] !== undefined) throw new PostgresMigrationError("MIGRATOR_ARGUMENT_INVALID", `Invalid or duplicate argument --${key}`);
    result[key] = value;
  }
  return result;
}

function scalar(value) {
  return typeof value === "string" ? value : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const code = error instanceof PostgresMigrationError ? error.code : "POSTGRES_MIGRATION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "FAIL", code, error: error instanceof Error ? error.name : "UnknownError" })}\n`);
    process.exitCode = 1;
  });
}
