#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
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
  const included = new Set(profile.required_batches ?? []);
  if (included.size !== 128 || [...included].some((batchId) => !batches.some((batch) => batch.id === batchId))) {
    throw new Error("active full-commercial profile must include all 128 batches");
  }

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
    schemaVersion: "ltm.factory-status.v1",
    package: { name: manifest.name, version: manifest.version },
    profile: { id: profile.id, includedBatches: included.size },
    canonicalSkills: { directory: "skills", count: skillNames.length, names: skillNames },
    implementationSurface: {
      batches: batches.length,
      requirements: batches.reduce(
        (sum, batch) => sum + (Array.isArray(batch.requirement_ids) ? batch.requirement_ids.length : 0),
        0,
      ),
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
    `Workflow: ${counts}`,
    `Production certification: ${status.productionCertification.status} (${status.productionCertification.verification})`,
    `Production authority: ${status.productionCertification.authority}`,
  ];
  if (readyOnly) lines.push(`Ready batches: ${status.factoryWorkflow.ready.join(", ") || "none"}`);
  else lines.push(status.factoryWorkflow.warning);
  return `${lines.join("\n")}\n`;
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
