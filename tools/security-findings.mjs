#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyFindingEvent, createFinding, validateFinding, validateFindingRegistry } from "../security/findings.mjs";
import { stableJson } from "../security/lib/canonical.mjs";

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const command = options._[0] ?? "validate";
  let result;
  if (command === "validate") {
    if (options.file === undefined) throw new Error("--file is required");
    const value = JSON.parse(readFileSync(resolve(options.file), "utf8"));
    result = Array.isArray(value) ? validateFindingRegistry(value) : validateFinding(value);
  } else if (command === "create") {
    result = createFinding(readJson(options.input, "--input"));
    outputRequired(options.output, result);
  } else if (command === "apply") {
    const finding = readJson(options.finding, "--finding");
    const event = readJson(options.event, "--event");
    result = applyFindingEvent(finding, event);
    outputRequired(options.output, result);
  } else throw new Error(`unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(Array.isArray(result) ? { status: "PASS" } : result)}\n`);
  if (result?.status === "FAIL") process.exitCode = 1;
  return result;
}

function readJson(path, label) { if (path === undefined) throw new Error(`${label} is required`); return JSON.parse(readFileSync(resolve(path), "utf8")); }
function outputRequired(path, value) {
  if (path === undefined) throw new Error("--output is required and must be a new versioned finding path");
  const target = resolve(path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, stableJson(value), { flag: "wx", mode: 0o600 });
}
function parse(argv) {
  const result = { _: [] };
  for (const item of argv) {
    if (!item.startsWith("--")) result._.push(item);
    else { const split = item.indexOf("="); if (split < 0) throw new Error(`invalid argument: ${item}`); result[item.slice(2, split)] = item.slice(split + 1); }
  }
  return result;
}
if (import.meta.url === `file://${process.argv[1]}`) { try { main(); } catch (error) { process.stderr.write(`SECURITY_FINDINGS ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
