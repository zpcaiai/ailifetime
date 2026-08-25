import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { formatFactoryStatus, loadFactoryStatus } from "./factory-status.mjs";

const root = resolve(import.meta.dirname, "..");

test("factory status keeps local workflow attestation separate from production certification", () => {
  const temporary = mkdtempSync(join(tmpdir(), "ltm-factory-status-"));
  mkdirSync(join(temporary, ".ai-life-time-machine/skill-package/manifests"), { recursive: true });
  mkdirSync(join(temporary, ".ai-life-time-machine/state"), { recursive: true });
  cpSync(join(root, ".ai-life-time-machine/skill-package/manifest.json"), join(temporary, ".ai-life-time-machine/skill-package/manifest.json"));
  cpSync(join(root, ".ai-life-time-machine/skill-package/manifests/batches.json"), join(temporary, ".ai-life-time-machine/skill-package/manifests/batches.json"));
  cpSync(join(root, ".ai-life-time-machine/project-profile.json"), join(temporary, ".ai-life-time-machine/project-profile.json"));
  cpSync(join(root, "skills"), join(temporary, "skills"), { recursive: true });
  const batches = JSON.parse(readFileSync(join(root, ".ai-life-time-machine/skill-package/manifests/batches.json"), "utf8"));
  const states = Object.fromEntries(batches.map((batch, index) => [batch.id, {
    state: index === 0 ? "factory_attested" : index === 1 ? "certified" : "planned",
  }]));
  writeFileSync(join(temporary, ".ai-life-time-machine/state/orchestration.json"), JSON.stringify({ profile_id: "full-commercial", batches: states }));

  const status = loadFactoryStatus(temporary);
  assert.equal(status.factoryWorkflow.counts.factory_attested, 2);
  assert.equal(status.factoryWorkflow.counts.certified, undefined);
  assert.equal(status.productionCertification.status, "NOT_CERTIFIED");
  assert.match(formatFactoryStatus(status), /not production certification/i);
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
