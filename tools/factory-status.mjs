#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_STATES = new Set([
  "planned",
  "ready",
  "running",
  "review",
  "merged",
  "factory_attested",
  "certified",
  "blocked",
  "excluded",
]);

export function loadFactoryStatus(rootValue = process.cwd()) {
  const root = resolve(rootValue);
  const manifest = json(resolve(root, ".ai-life-time-machine/skill-package/manifest.json"), "factory manifest");
  const profile = json(resolve(root, ".ai-life-time-machine/project-profile.json"), "active factory profile");
  const batches = jsonArray(resolve(root, ".ai-life-time-machine/skill-package/manifests/batches.json"), "batch manifest");
  const statePath = resolve(root, ".ai-life-time-machine/state/orchestration.json");
  const state = existsSync(statePath) ? json(statePath, "factory workflow state") : undefined;
  if (batches.length !== 128 || new Set(batches.map((item) => item?.id)).size !== 128) {
    throw new Error("batch manifest must contain 128 unique batches");
  }
  const skillNames = readdirSync(resolve(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(root, "skills", entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  if (skillNames.length !== 22) throw new Error("canonical skills directory must contain exactly 22 skills");
  const manifestSkills = [...new Set(batches.map((batch) => batch?.skill))].sort();
  if (manifestSkills.length !== 22 || JSON.stringify(manifestSkills) !== JSON.stringify(skillNames)) {
    throw new Error("canonical skill names must exactly match the batch manifest");
  }
  const included = new Set(profile.required_batches ?? []);
  if (included.size !== 128 || [...included].some((batchId) => !batches.some((batch) => batch.id === batchId))) {
    throw new Error("active full-commercial profile must include all 128 batches");
  }
  const executable = loadExecutableCapabilityInventory(root, batches, skillNames);

  const workflowCounts = {};
  const ready = [];
  if (state !== undefined) {
    if (state.profile_id !== profile.id || typeof state.batches !== "object" || state.batches === null) {
      throw new Error("factory workflow state does not match the active profile");
    }
    for (const batch of batches) {
      const rawState = state.batches[batch.id]?.state;
      if (!WORKFLOW_STATES.has(rawState)) throw new Error(`invalid workflow state for ${batch.id}`);
      // Legacy "certified" means only that the local Factory accepted a file.
      // Rename it so it cannot be confused with independently verified B127.
      const displayState = rawState === "certified" ? "factory_attested" : rawState;
      workflowCounts[displayState] = (workflowCounts[displayState] ?? 0) + 1;
      if (rawState === "ready") ready.push(batch.id);
    }
  }

  return {
    schemaVersion: "ltm.factory-status.v2",
    package: { name: manifest.name, version: manifest.version },
    profile: { id: profile.id, includedBatches: included.size },
    canonicalSkills: { directory: "skills", count: skillNames.length, names: skillNames },
    implementationSurface: {
      batches: batches.length,
      requirements: batches.reduce(
        (sum, batch) => sum + (Array.isArray(batch.requirement_ids) ? batch.requirement_ids.length : 0),
        0,
      ),
      executableBatches: executable.batches,
      dedicatedValidators: executable.validators,
      boundRequirements: executable.requirements,
      sourceModules: executable.sourceModules,
      bySkill: executable.bySkill,
      verification: "NOT_RUN",
      verifyCommand: "pnpm check",
    },
    factoryWorkflow: {
      scope: "CODE_IMPLEMENTATION_WORKFLOW_ONLY",
      stateFilePresent: state !== undefined,
      counts: workflowCounts,
      ready,
      warning: "factory_attested/merged are local workflow states, not production certification",
    },
    productionCertification: {
      status: "NOT_CERTIFIED",
      verification: "NOT_RUN",
      authority: "node tools/release-gate.mjs --profile=production --run-audit",
      requirement: "live PostgreSQL/FORCE-RLS B127 evidence plus independent signed approvals",
    },
  };
}

export function formatFactoryStatus(status, readyOnly = false) {
  const counts = Object.entries(status.factoryWorkflow.counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state}=${count}`)
    .join(", ") || "uninitialized";
  const lines = [
    `Factory scope: ${status.factoryWorkflow.scope}`,
    `Profile: ${status.profile.id} | included ${status.profile.includedBatches}/${status.implementationSurface.batches}`,
    `Canonical skills: ${status.canonicalSkills.count} in ${status.canonicalSkills.directory}/`,
    `Executable mappings: ${status.implementationSurface.executableBatches}/${status.implementationSurface.batches} batches | ` +
      `${status.implementationSurface.boundRequirements}/${status.implementationSurface.requirements} requirement IDs | ` +
      `${status.implementationSurface.dedicatedValidators} dedicated validators`,
    `Workflow: ${counts}`,
    `Production certification: ${status.productionCertification.status} (${status.productionCertification.verification})`,
    `Production authority: ${status.productionCertification.authority}`,
  ];
  if (readyOnly) lines.push(`Ready batches: ${status.factoryWorkflow.ready.join(", ") || "none"}`);
  else lines.push(status.factoryWorkflow.warning);
  return `${lines.join("\n")}\n`;
}

function loadExecutableCapabilityInventory(root, batches, skillNames) {
  const directory = resolve(root, "packages/capabilities/src/domains");
  if (!existsSync(directory)) throw new Error("executable capability domain source directory is missing");
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && entry.name !== "_shared.ts")
    .map((entry) => resolve(directory, entry.name))
    .sort();
  const definitions = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const skill = /^const SKILL = "([a-z0-9-]+)";$/mu.exec(source)?.[1];
    if (skill === undefined) throw new Error(`capability source has no closed skill binding: ${relative(root, file)}`);
    const pattern = /defineCapability\(\s*"(B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))"\s*,\s*SKILL\s*,\s*"([a-z][A-Za-z0-9]+)"\s*,\s*([a-z][A-Za-z0-9]+)\s*,/gu;
    for (const match of source.matchAll(pattern)) {
      const [, batchId, operation, validator] = match;
      if (!new RegExp(`function\\s+${validator}\\s*\\(`, "u").test(source)) {
        throw new Error(`${batchId} does not bind a declared domain validator ${validator}`);
      }
      definitions.push({ batchId, operation, validator, skill, source: relative(root, file) });
    }
  }
  if (files.length !== 22) throw new Error(`capability source must contain exactly 22 domain modules, got ${files.length}`);
  if (definitions.length !== 128) throw new Error(`capability source must contain exactly 128 executable definitions, got ${definitions.length}`);
  for (const field of ["batchId", "operation", "validator"]) {
    if (new Set(definitions.map((definition) => definition[field])).size !== definitions.length) {
      throw new Error(`capability source contains a duplicate ${field}`);
    }
  }
  const byBatch = new Map(definitions.map((definition) => [definition.batchId, definition]));
  const requirementIds = new Set();
  for (const batch of batches) {
    const definition = byBatch.get(batch.id);
    if (definition === undefined) throw new Error(`batch ${batch.id} has no executable capability definition`);
    if (definition.skill !== batch.skill) throw new Error(`batch ${batch.id} executable skill binding does not match the manifest`);
    if (!Array.isArray(batch.requirement_ids) || batch.requirement_ids.length !== 5) {
      throw new Error(`batch ${batch.id} must declare exactly five requirement IDs`);
    }
    for (const [index, requirementId] of batch.requirement_ids.entries()) {
      if (requirementId !== `${batch.id}-R0${index + 1}` || requirementIds.has(requirementId)) {
        throw new Error(`batch ${batch.id} has an invalid or duplicate requirement binding`);
      }
      requirementIds.add(requirementId);
    }
    if (typeof batch.reference !== "string" || !existsSync(resolve(root, batch.reference))) {
      throw new Error(`batch ${batch.id} canonical skill reference is missing`);
    }
  }
  const sourceSkills = [...new Set(definitions.map((definition) => definition.skill))].sort();
  if (JSON.stringify(sourceSkills) !== JSON.stringify(skillNames)) {
    throw new Error("executable capability skills do not exactly cover the canonical skill catalog");
  }
  return {
    batches: definitions.length,
    validators: new Set(definitions.map((definition) => definition.validator)).size,
    requirements: requirementIds.size,
    sourceModules: files.length,
    bySkill: Object.fromEntries(skillNames.map((skill) => {
      const skillDefinitions = definitions.filter((definition) => definition.skill === skill);
      return [skill, {
        batches: skillDefinitions.length,
        requirements: skillDefinitions.length * 5,
        source: skillDefinitions[0]?.source,
      }];
    })),
  };
}

function json(path, label) {
  const value = parse(path, label);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function jsonArray(path, label) {
  const value = parse(path, label);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function parse(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${label} is unreadable: ${error instanceof Error ? error.message : "unknown error"}`); }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = new Set(process.argv.slice(2));
    const allowed = new Set(["--json", "--ready"]);
    for (const argument of arguments_) if (!allowed.has(argument)) throw new Error(`unknown argument: ${argument}`);
    const status = loadFactoryStatus();
    process.stdout.write(arguments_.has("--json")
      ? `${JSON.stringify(status, null, 2)}\n`
      : formatFactoryStatus(status, arguments_.has("--ready")));
  } catch (error) {
    process.stderr.write(`FACTORY_STATUS_FAILED: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
