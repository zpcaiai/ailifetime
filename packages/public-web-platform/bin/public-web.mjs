#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  buildStaticSite,
  evaluatePublicSiteMonitoring,
  PublicWebError,
  validateSiteConfiguration,
  verifyBuiltSite,
  VersionedMarketingStore,
} from "../src/index.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function usage() {
  return `Usage:
  ltm-public-web verify --config=<site.json>
  ltm-public-web build --config=<site.json> --out=<directory>
  ltm-public-web inspect-build --config=<site.json> --out=<directory>
  ltm-public-web monitor --input=<monitoring.json>
  ltm-public-web init-state --state=<absolute-state.json>
`;
}

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (const item of rest) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(item);
    if (match === null || Object.hasOwn(options, match[1])) throw new PublicWebError("CLI_ARGUMENT_INVALID", `unsupported or duplicate argument: ${item}`);
    options[match[1]] = match[2];
  }
  return { command, options };
}

function readJsonFile(pathValue, label) {
  const path = resolve(pathValue);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_INPUT_BYTES) throw new PublicWebError("CLI_INPUT_INVALID", `${label} must be a bounded regular file`);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stable = fstatSync(descriptor);
    if (!stable.isFile() || stable.size !== metadata.size) throw new PublicWebError("CLI_INPUT_CHANGED", `${label} changed while being read`);
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof PublicWebError) throw error;
    throw new PublicWebError("CLI_INPUT_INVALID", `${label} is not valid JSON`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function only(options, expected) {
  const actual = Object.keys(options).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new PublicWebError("CLI_ARGUMENT_INVALID", `expected exactly ${wanted.map((key) => `--${key}`).join(", ")}`);
}

export function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "verify") {
    only(options, ["config"]);
    const configuration = validateSiteConfiguration(readJsonFile(options.config, "site configuration"));
    return { schemaVersion: "ltm.public-web-cli.v1", command, status: "PASS", locales: configuration.site.locales, pageCount: configuration.pages.length };
  }
  if (command === "build") {
    only(options, ["config", "out"]);
    return buildStaticSite(readJsonFile(options.config, "site configuration"), resolve(options.out));
  }
  if (command === "inspect-build") {
    only(options, ["config", "out"]);
    return verifyBuiltSite(readJsonFile(options.config, "site configuration"), resolve(options.out));
  }
  if (command === "monitor") {
    only(options, ["input"]);
    return evaluatePublicSiteMonitoring(readJsonFile(options.input, "monitoring input"));
  }
  if (command === "init-state") {
    only(options, ["state"]);
    if (!isAbsolute(options.state)) throw new PublicWebError("STORE_PATH_INVALID", "--state must be an absolute path");
    const store = new VersionedMarketingStore(options.state);
    const state = store.initialize();
    return { schemaVersion: state.schemaVersion, revision: state.revision, path: store.path };
  }
  throw new PublicWebError("CLI_COMMAND_INVALID", `${usage().trim()}\nUnknown command: ${command ?? "(missing)"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(runCli())}\n`);
  } catch (error) {
    const output = error instanceof PublicWebError
      ? { status: "FAIL", code: error.code, message: error.message }
      : { status: "FAIL", code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
  }
}
