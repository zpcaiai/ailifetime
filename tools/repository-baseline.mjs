#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COMMANDS = ["build", "lint", "typecheck", "test", "test:e2e"];
const IGNORED_DIRECTORIES = new Set([
  ".git", ".artifacts", ".data", ".next", ".venv", "build", "coverage", "dist", "node_modules",
  "playwright-report", "__pycache__",
]);
const LANGUAGE_BY_EXTENSION = new Map([
  [".ts", "TypeScript"], [".tsx", "TypeScript"], [".mts", "TypeScript"],
  [".js", "JavaScript"], [".mjs", "JavaScript"], [".cjs", "JavaScript"],
  [".py", "Python"], [".java", "Java"], [".sql", "SQL"],
  [".yaml", "YAML"], [".yml", "YAML"], [".json", "JSON"],
  [".md", "Markdown"], [".wxml", "WXML"], [".wxss", "WXSS"],
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(?:live|prod)-[A-Za-z0-9_-]{12,}\b/,
];

export function collectRepositoryBaseline(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const outputDirectory = safeOutputDirectory(root, options.outputDirectory ?? ".artifacts/repository-baseline");
  const requestedCommands = normalizeRequestedCommands(options.commands ?? []);
  const packageManifest = readJson(join(root, "package.json"), "package manifest");
  const scripts = objectValue(packageManifest.scripts, "package scripts");
  const startedAt = new Date().toISOString();
  const files = walk(root);
  const inventory = buildInventory(root, files, packageManifest);
  const commandResults = evaluateCommands(root, scripts, requestedCommands);
  const dependencyPlan = buildDependencyPlan(root, files);
  const risks = buildRiskRegister(root, files, commandResults);
  const inventorySha256 = digestJson(inventory);
  const completedAt = new Date().toISOString();
  const report = {
    schemaVersion: "ltm.repository-baseline.v1",
    startedAt,
    completedAt,
    repositoryRoot: root,
    inventorySha256,
    inventory,
    commands: commandResults,
    dependencyPlanSha256: digestJson(dependencyPlan),
    riskRegisterSha256: digestJson(risks),
    status: commandResults.some((item) => item.status === "failed") ? "FAILED" : "OBSERVED",
  };

  writeArtifacts(outputDirectory, inventory, commandResults, dependencyPlan, risks, report);
  return Object.freeze({ outputDirectory, report });
}

function buildInventory(root, files, packageManifest) {
  const languageCounts = {};
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION.get(extname(file));
    if (language !== undefined) languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }
  const topLevel = readdirSync(root, { withFileTypes: true });
  const workspacePackages = ["apps", "services", "packages"].flatMap((folder) =>
    listChildDirectories(join(root, folder)).map((name) => `${folder}/${name}`),
  );
  const entrypoints = files.filter((path) => /(?:^|\/)(?:src\/main\.(?:ts|js|mjs)|Dockerfile)$/.test(path)).sort();
  const migrations = files.filter((path) => /^infra\/postgres\/migrations\/[^/]+\.(?:sql|json)$/.test(path)).sort();
  const deployment = files.filter((path) => /^(?:compose\.yaml|infra\/kubernetes\/|\.github\/workflows\/)/.test(path)).sort();
  const git = gitInventory(root);
  const compose = files.includes("compose.yaml") ? readFileSync(join(root, "compose.yaml"), "utf8") : "";
  return {
    schemaVersion: "ltm.repository-inventory.v1",
    repository: {
      kind: existsSync(join(root, "pnpm-workspace.yaml")) ? "monorepo" : "single_repo",
      git,
      packageManager: typeof packageManifest.packageManager === "string" ? packageManifest.packageManager : "unknown",
      nodeEngine: objectValue(packageManifest.engines ?? {}, "package engines").node ?? "unknown",
    },
    workspacePackages,
    languages: Object.entries(languageCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, fileCount]) => ({ name, fileCount })),
    buildManifests: files.filter((path) => /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|tsconfig\.json|Dockerfile)$/.test(path)).sort(),
    entrypoints,
    databases: {
      migrations,
      postgres: /(?:^|\n)\s*postgres:\s*$/m.test(compose),
      redis: /(?:^|\n)\s*redis:\s*$/m.test(compose),
      objectStorage: /(?:^|\n)\s*object-storage:\s*$/m.test(compose),
    },
    deployment,
    directories: topLevel.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    skillCount: listChildDirectories(join(root, "skills")).filter((name) => existsSync(join(root, "skills", name, "SKILL.md"))).length,
    sourceFileCount: files.length,
  };
}

function evaluateCommands(root, scripts, requestedCommands) {
  const names = [...new Set([...DEFAULT_COMMANDS, ...requestedCommands])];
  return names.map((name) => {
    const command = scripts[name];
    if (typeof command !== "string" || command.trim() === "") {
      return { name, command: null, status: "missing", exitCode: null, durationMs: 0 };
    }
    if (!requestedCommands.includes(name)) {
      return { name, command: `pnpm run ${name}`, status: "skipped", exitCode: null, durationMs: 0 };
    }
    const started = Date.now();
    const result = spawnSync("pnpm", ["run", name], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
      maxBuffer: 8 * 1_024 * 1_024,
      shell: false,
    });
    const stdout = sanitizeOutput(result.stdout ?? "");
    const stderr = sanitizeOutput(result.stderr ?? "");
    const exitCode = result.status ?? 1;
    return {
      name,
      command: `pnpm run ${name}`,
      status: exitCode === 0 && result.error === undefined ? "passed" : "failed",
      exitCode,
      durationMs: Date.now() - started,
      stdoutSha256: digest(stdout),
      stderrSha256: digest(stderr),
      stdoutTail: stdout.slice(-4_096),
      stderrTail: stderr.slice(-4_096),
      ...(result.error === undefined ? {} : { error: result.error.name }),
    };
  });
}

function buildDependencyPlan(root, files) {
  const batchManifest = readJson(join(root, ".ai-life-time-machine/skill-package/manifests/batches.json"), "batch manifest");
  if (!Array.isArray(batchManifest) || batchManifest.length !== 128) throw new Error("batch manifest must contain 128 entries");
  const capabilityFiles = files.filter((path) => /^packages\/capabilities\/src\/domains\/[^/]+\.ts$/.test(path));
  const sourcesByBatch = new Map();
  for (const path of capabilityFiles) {
    const source = readFileSync(join(root, path), "utf8");
    for (const match of source.matchAll(/defineCapability\(\s*["'](B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))["']/g)) {
      const batchId = match[1];
      const current = sourcesByBatch.get(batchId) ?? [];
      current.push(path);
      sourcesByBatch.set(batchId, current);
    }
  }
  return {
    schemaVersion: "ltm.batch-dependency-plan.v1",
    batches: batchManifest.map((batch) => {
      const sourceFiles = [...new Set(sourcesByBatch.get(batch.id) ?? [])].sort();
      return {
        batchId: batch.id,
        skill: batch.skill,
        dependsOn: Array.isArray(batch.depends_on) ? batch.depends_on : [],
        decision: sourceFiles.length > 0 ? "reuse" : "new",
        sourceFiles,
      };
    }),
  };
}

function buildRiskRegister(root, files, commandResults) {
  const secretFindings = [];
  for (const path of files) {
    if (!/\.(?:ts|tsx|js|mjs|java|py|sql|ya?ml|json)$/.test(path) || /(?:^|\/)(?:test|tests|fixtures)(?:\/|\.)/.test(path)) continue;
    const value = readFileSync(join(root, path), "utf8");
    for (const pattern of SECRET_PATTERNS) if (pattern.test(value)) secretFindings.push(path);
  }
  const unrun = commandResults.filter((item) => item.status === "skipped" || item.status === "missing").map((item) => item.name);
  return {
    schemaVersion: "ltm.repository-risk-register.v1",
    threats: [
      { id: "tenant-boundary", control: "application authorization plus PostgreSQL FORCE RLS", status: "tracked" },
      { id: "external-side-effect-replay", control: "transactional intent, outbox, signed callback and idempotency", status: "tracked" },
      { id: "sensitive-media-lifecycle", control: "quarantine, purpose consent, retention and deletion receipts", status: "tracked" },
      { id: "release-evidence-forgery", control: "digest-bound independent Ed25519 evidence and fail-closed B127", status: "tracked" },
    ],
    technicalDebt: unrun.map((command) => ({ id: `unrun:${command}`, disposition: "verification_required" })),
    secretScan: { status: secretFindings.length === 0 ? "passed" : "failed", findings: [...new Set(secretFindings)].sort() },
    licenseReview: { status: "requires pnpm audit and signed SBOM evidence", policy: "security/license-policy.json" },
    irreversibleOperations: [
      "production database destructive migration",
      "provider payment capture or refund",
      "public release or app-store submission",
      "production data deletion",
      "Git history rewrite",
    ],
  };
}

function writeArtifacts(outputDirectory, inventory, commands, dependencyPlan, risks, report) {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(outputDirectory).isSymbolicLink() || !lstatSync(outputDirectory).isDirectory()) {
    throw new Error("baseline output must be a real directory");
  }
  chmodSync(outputDirectory, 0o700);
  atomicWrite(join(outputDirectory, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  atomicWrite(join(outputDirectory, "command-log.ndjson"), commands.map((item) => JSON.stringify(item)).join("\n") + "\n");
  atomicWrite(join(outputDirectory, "dependency-plan.json"), `${JSON.stringify(dependencyPlan, null, 2)}\n`);
  atomicWrite(join(outputDirectory, "risk-register.json"), `${JSON.stringify(risks, null, 2)}\n`);
  atomicWrite(join(outputDirectory, "baseline-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const counts = Object.fromEntries(["passed", "failed", "skipped", "missing"].map((state) => [state, commands.filter((item) => item.status === state).length]));
  atomicWrite(join(outputDirectory, "baseline-report.md"), [
    "# Repository baseline",
    "",
    `- Status: \`${report.status}\``,
    `- Repository: \`${report.repositoryRoot}\``,
    `- Commit: \`${report.inventory.repository.git.head}\``,
    `- Inventory SHA-256: \`${report.inventorySha256}\``,
    `- Commands: passed=${counts.passed}, failed=${counts.failed}, skipped=${counts.skipped}, missing=${counts.missing}`,
    `- Batch dependency decisions: ${dependencyPlan.batches.length}`,
    `- Secret-pattern findings: ${risks.secretScan.findings.length}`,
    "",
    "Skipped, missing, and failed commands remain explicit in command-log.ndjson and are never promoted to passed.",
    "Production provider, legal, penetration-test, disaster-recovery, store, and rollout evidence is outside this local baseline.",
    "",
  ].join("\n"));
}

function atomicWrite(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function safeOutputDirectory(root, value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new Error("baseline output path is invalid");
  const output = resolve(root, value);
  if (output === root || root.startsWith(`${output}${sep}`) || output === resolve("/")) {
    throw new Error("baseline output cannot replace the repository or one of its ancestors");
  }
  const outputRelative = relative(root, output);
  if (outputRelative.startsWith(`..${sep}`) || outputRelative === "..") {
    throw new Error("baseline output must remain inside the repository");
  }
  let component = root;
  for (const segment of outputRelative.split(sep)) {
    component = join(component, segment);
    if (existsSync(component) && lstatSync(component).isSymbolicLink()) {
      throw new Error("baseline output ancestor cannot be a symbolic link");
    }
  }
  return output;
}

function gitInventory(root) {
  const run = (arguments_) => spawnSync("git", arguments_, { cwd: root, encoding: "utf8", shell: false });
  const head = run(["rev-parse", "HEAD"]);
  if (head.status !== 0) return { present: false, head: "NOT_AVAILABLE", branch: "NOT_AVAILABLE", dirty: null };
  const branch = run(["branch", "--show-current"]);
  const status = run(["status", "--porcelain=v1", "--untracked-files=normal"]);
  return {
    present: true,
    head: head.stdout.trim(),
    branch: branch.status === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : "DETACHED",
    dirty: status.status === 0 ? status.stdout.trim() !== "" : null,
  };
}

function walk(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  visit(root);
  return result;
}

function normalizeRequestedCommands(value) {
  if (!Array.isArray(value)) throw new Error("baseline commands must be an array");
  const result = value.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
  for (const item of result) if (!/^[a-z][a-z0-9:_-]{0,63}$/.test(item)) throw new Error(`invalid package script name: ${item}`);
  return [...new Set(result)];
}

function sanitizeOutput(value) {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:AKIA[0-9A-Z]{16}|sk-(?:live|prod)-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_SECRET]");
}

function listChildDirectories(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${label} is unreadable: ${error instanceof Error ? error.message : "unknown error"}`); }
}

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value) {
  return digest(JSON.stringify(value));
}

function parseArguments(arguments_) {
  let outputDirectory;
  const commands = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--output") {
      outputDirectory = arguments_[index + 1];
      if (outputDirectory === undefined) throw new Error("--output requires a path");
      index += 1;
    } else if (argument === "--run") {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error("--run requires comma-separated package scripts");
      commands.push(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { outputDirectory, commands };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = collectRepositoryBaseline({
      root: process.cwd(),
      ...(options.outputDirectory === undefined ? {} : { outputDirectory: options.outputDirectory }),
      commands: options.commands,
    });
    process.stdout.write(`${JSON.stringify({ status: result.report.status, outputDirectory: result.outputDirectory, inventorySha256: result.report.inventorySha256 })}\n`);
    if (result.report.status === "FAILED") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`REPOSITORY_BASELINE_FAILED: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
