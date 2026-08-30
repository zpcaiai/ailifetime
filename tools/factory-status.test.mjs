import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { formatFactoryStatus, loadFactoryStatus } from "./factory-status.mjs";

const root = resolve(import.meta.dirname, "..");

function factoryFixture() {
  const sandbox = mkdtempSync(join(tmpdir(), "ltm-factory-status-"));
  const repo = join(sandbox, "repo");
  mkdirSync(join(repo, ".ai-life-time-machine/skill-package/manifests"), { recursive: true });
  mkdirSync(join(repo, ".ai-life-time-machine/state"), { recursive: true });
  mkdirSync(join(repo, "packages/capabilities/src"), { recursive: true });
  cpSync(join(root, ".ai-life-time-machine/skill-package/manifest.json"), join(repo, ".ai-life-time-machine/skill-package/manifest.json"));
  cpSync(join(root, ".ai-life-time-machine/skill-package/manifests/batches.json"), join(repo, ".ai-life-time-machine/skill-package/manifests/batches.json"));
  cpSync(join(root, ".ai-life-time-machine/skill-package/manifests/topological-order.json"), join(repo, ".ai-life-time-machine/skill-package/manifests/topological-order.json"));
  cpSync(join(root, ".ai-life-time-machine/project-profile.json"), join(repo, ".ai-life-time-machine/project-profile.json"));
  cpSync(join(root, "skills"), join(repo, "skills"), { recursive: true });
  cpSync(join(root, "packages/capabilities/src/domains"), join(repo, "packages/capabilities/src/domains"), {
    recursive: true,
    filter: (source) => !/\.(?:js|d\.ts|map)$/u.test(source),
  });
  for (const arguments_ of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "factory-test@example.invalid"],
    ["config", "user.name", "Factory Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", arguments_, { cwd: repo, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, `git ${arguments_.join(" ")}: ${result.stderr}`);
  }
  return { repo, sandbox };
}

function addFixtureWorktree(fixture, branch, name) {
  const parent = join(fixture.sandbox, "worktrees");
  mkdirSync(parent, { recursive: true });
  const worktree = join(parent, name);
  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], { cwd: fixture.repo, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return worktree;
}

function runOrchestrator(repo, state, ...arguments_) {
  const fixtureOrchestrator = join(repo, "skills/orchestrating-life-time-machine/scripts/orchestrate_batches.py");
  return spawnSync("python3", [fixtureOrchestrator, "--repo", repo, "--state", state, ...arguments_], {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function orchestrationOk(repo, state, ...arguments_) {
  const result = runOrchestrator(repo, state, ...arguments_);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("factory status keeps local workflow attestation separate from production certification", (testContext) => {
  const fixture = factoryFixture();
  testContext.after(() => rmSync(fixture.sandbox, { recursive: true, force: true }));
  const temporary = fixture.repo;
  const batches = JSON.parse(readFileSync(join(root, ".ai-life-time-machine/skill-package/manifests/batches.json"), "utf8"));
  const states = Object.fromEntries(batches.map((batch, index) => [batch.id, {
    state: index === 0 ? "factory_attested" : index === 1 ? "certified" : "planned",
  }]));
  writeFileSync(join(temporary, ".ai-life-time-machine/state/orchestration.json"), JSON.stringify({ profile_id: "full-commercial", batches: states }));

  const status = loadFactoryStatus(temporary);
  assert.equal(status.factoryWorkflow.counts.factory_attested, 2);
  assert.equal(status.factoryWorkflow.counts.certified, undefined);
  assert.equal(status.implementationSurface.executableBatches, 128);
  assert.equal(status.implementationSurface.dedicatedValidators, 128);
  assert.equal(status.implementationSurface.boundRequirements, 640);
  assert.equal(Object.keys(status.implementationSurface.bySkill).length, 22);
  assert.equal(status.productionCertification.status, "NOT_CERTIFIED");
  assert.match(formatFactoryStatus(status), /not production certification/i);
});

test("factory status fails closed when a manifest batch loses its executable mapping", (testContext) => {
  const fixture = factoryFixture();
  testContext.after(() => rmSync(fixture.sandbox, { recursive: true, force: true }));
  const temporary = fixture.repo;
  const target = join(temporary, "packages/capabilities/src/domains/launching-complete-commercial-product.ts");
  writeFileSync(target, readFileSync(target, "utf8").replace('defineCapability("B127"', 'defineCapability("B126"'));
  assert.throws(() => loadFactoryStatus(temporary), /128 executable definitions|duplicate batchId|no executable capability/u);
});

test("canonical B50 orchestration provides owned leases, heartbeat, context, and explicit expiry recovery", (testContext) => {
  const fixture = factoryFixture();
  testContext.after(() => rmSync(fixture.sandbox, { recursive: true, force: true }));
  const temporary = fixture.repo;
  const state = join(temporary, "orchestration.json");
  orchestrationOk(temporary, state, "init");
  const worktree = addFixtureWorktree(fixture, "feat/b00", "worktree-b00");
  orchestrationOk(
    temporary, state, "start", "B00",
    "--owner", "agent-a",
    "--worktree", worktree,
    "--branch", "feat/b00",
    "--allowed-path", "docs/baseline",
    "--forbid", "production-write",
    "--acceptance-command", "pnpm check",
  );
  const wrongOwner = runOrchestrator(temporary, state, "heartbeat", "B00", "--owner", "agent-b");
  assert.equal(wrongOwner.status, 1);
  assert.match(wrongOwner.stderr, /lease is owned by/u);
  orchestrationOk(temporary, state, "heartbeat", "B00", "--owner", "agent-a", "--lease-minutes", "5");

  const contextPath = join(temporary, "context-b00.json");
  orchestrationOk(temporary, state, "context-package", "B00", "--output", contextPath);
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  assert.equal(context.scope, "code_implementation_only");
  assert.equal(context.production_certification, "NOT_CERTIFIED");
  assert.deepEqual(context.allowed_paths, ["docs/baseline"]);
  assert.deepEqual(context.forbidden_operations, ["production-write"]);
  assert.deepEqual(context.acceptance_commands, ["pnpm check"]);

  const expired = JSON.parse(readFileSync(state, "utf8"));
  expired.batches.B00.lease_expires_at = "2000-01-01T00:00:00+00:00";
  writeFileSync(state, `${JSON.stringify(expired, null, 2)}\n`);
  orchestrationOk(temporary, state, "reclaim-expired", "B00", "--reclaimed-by", "coordinator");
  const reclaimed = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(reclaimed.batches.B00.state, "ready");
  assert.equal(reclaimed.batches.B00.lease_owner, null);
  assert.deepEqual(reclaimed.batches.B00.allowed_paths, []);
  assert.match(reclaimed.batches.B00.notes, /expired_lease_reclaimed_by=coordinator/u);
});

test("canonical B50 orchestration rejects overlapping active path ownership", (testContext) => {
  const fixture = factoryFixture();
  testContext.after(() => rmSync(fixture.sandbox, { recursive: true, force: true }));
  const temporary = fixture.repo;
  const state = join(temporary, "orchestration.json");
  orchestrationOk(temporary, state, "init");
  const prepared = JSON.parse(readFileSync(state, "utf8"));
  prepared.batches.B01.state = "running";
  prepared.batches.B01.allowed_paths = ["packages/shared"];
  writeFileSync(state, `${JSON.stringify(prepared, null, 2)}\n`);
  const worktree = addFixtureWorktree(fixture, "feat/b00", "worktree-b00");
  const overlap = runOrchestrator(
    temporary, state, "start", "B00",
    "--owner", "agent-b",
    "--worktree", worktree,
    "--branch", "feat/b00",
    "--allowed-path", "packages/shared/contracts",
  );
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /Owned path conflict/u);
});

test("canonical orchestration cannot promote a local file to production certified", () => {
  for (const relative of [
    "skills/orchestrating-life-time-machine/scripts/orchestrate_batches.py",
  ]) {
    const source = readFileSync(join(root, relative), "utf8");
    assert.match(source, /factory_attested/);
    assert.match(source, /productionReleaseApproved/);
    assert.match(source, /NOT_CERTIFIED/);
    assert.doesNotMatch(source, /(?:\["state"\]|'state')\s*=\s*["']certified["']/);
  }
});

test("canonical completion verifier rejects prose-only traceability and empty entrypoints", (testContext) => {
  const fixture = factoryFixture();
  testContext.after(() => rmSync(fixture.sandbox, { recursive: true, force: true }));
  const temporary = fixture.repo;
  const report = join(temporary, "evidence/completion/B00.json");
  mkdirSync(join(temporary, "evidence/completion"), { recursive: true });
  cpSync(join(root, ".ai-life-time-machine/skill-package/templates/completion-report.example.json"), report);
  const result = spawnSync("python3", [
    join(temporary, "skills/certifying-life-time-machine-release/scripts/verify_release.py"),
    "--repo", temporary,
    "--batch", "B00",
    "--report", report,
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /entrypoints must be non-empty/u);
  assert.match(result.stderr, /repo_root must resolve to the verified repository/u);
  assert.match(result.stderr, /traceability B00-R01\.source_files must resolve in result commit/u);
  assert.match(result.stderr, /traceability B00-R01 contains an invalid symbol/u);
});

test("vendored factory 2.0.0 remains byte-for-byte checksum controlled", () => {
  const vendorRoot = join(root, ".ai-life-time-machine/skill-package");
  const entries = readFileSync(join(vendorRoot, "CHECKSUMS.sha256"), "utf8").trim().split("\n");
  assert.equal(entries.length, 317);
  const paths = new Set();
  for (const entry of entries) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(entry);
    assert.ok(match, `invalid checksum entry: ${entry}`);
    const [, expected, path] = match;
    const target = resolve(vendorRoot, path);
    const escaped = relative(vendorRoot, target);
    assert.equal(escaped === ".." || escaped.startsWith(`..${sep}`), false, `checksum path escapes vendor root: ${path}`);
    assert.equal(paths.has(path), false, `duplicate checksum path: ${path}`);
    paths.add(path);
    assert.equal(createHash("sha256").update(readFileSync(target)).digest("hex"), expected, path);
  }
});

test("canonical skill CLIs resolve the repository package and execute", () => {
  const run = (relative, ...arguments_) => {
    const result = spawnSync("python3", [join(root, relative), ...arguments_], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `${relative}: ${result.stderr}`);
    return result.stdout;
  };
  const canonical = JSON.parse(run(
    "skills/orchestrating-life-time-machine/scripts/list_batches.py",
    "--criticality", "high", "--json",
  ));
  assert.equal(canonical.length, 117);
  assert.equal(realpathSync(join(root, ".agents/skills")), realpathSync(join(root, "skills")));
  for (const relative of [
    "skills/orchestrating-life-time-machine/scripts/orchestrate_batches.py",
    "skills/certifying-life-time-machine-release/scripts/verify_release.py",
  ]) assert.match(run(relative, "--help"), /usage:/);
});
