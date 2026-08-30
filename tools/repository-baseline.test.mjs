import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { collectRepositoryBaseline } from "./repository-baseline.mjs";

const root = new URL("..", import.meta.url).pathname;

test("B00 repository baseline emits machine-readable inventory without promoting unrun commands", () => {
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".artifacts/ltm-repository-baseline-test-"));
  try {
    const output = join(temporary, "evidence");
    const result = collectRepositoryBaseline({ root, outputDirectory: output });
    assert.equal(result.report.inventory.repository.kind, "monorepo");
    assert.equal(result.report.inventory.skillCount, 22);
    assert.equal(result.report.status, "OBSERVED");
    const inventory = JSON.parse(readFileSync(join(output, "inventory.json"), "utf8"));
    const plan = JSON.parse(readFileSync(join(output, "dependency-plan.json"), "utf8"));
    const risks = JSON.parse(readFileSync(join(output, "risk-register.json"), "utf8"));
    const commandLog = readFileSync(join(output, "command-log.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(inventory.databases.postgres, true);
    assert.equal(inventory.databases.redis, true);
    assert.equal(inventory.databases.objectStorage, true);
    assert.equal(plan.batches.length, 128);
    assert.equal(plan.batches.every((batch) => batch.sourceFiles.length === 1 && batch.decision === "reuse"), true);
    assert.equal(commandLog.some((entry) => entry.status === "passed"), false);
    assert.equal(commandLog.find((entry) => entry.name === "build")?.status, "skipped");
    assert.equal(commandLog.find((entry) => entry.name === "test:e2e")?.status, "missing");
    assert.equal(risks.technicalDebt.some((item) => item.id === "unrun:test:e2e"), true);
    assert.match(readFileSync(join(output, "baseline-report.md"), "utf8"), /never promoted to passed/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("B00 baseline refuses to overwrite the repository or follow an output symlink", () => {
  assert.throws(() => collectRepositoryBaseline({ root, outputDirectory: root }), /cannot replace the repository/);
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".artifacts/ltm-repository-baseline-link-"));
  try {
    const actual = join(temporary, "actual");
    const linked = join(temporary, "linked");
    mkdirSync(join(actual, "nested"), { recursive: true });
    symlinkSync(actual, linked, "dir");
    assert.throws(
      () => collectRepositoryBaseline({ root, outputDirectory: join(linked, "nested") }),
      /ancestor cannot be a symbolic link/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
