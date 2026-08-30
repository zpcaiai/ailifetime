import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../bin/public-web.mjs";
import { publishLandingPage, VersionedMarketingStore } from "../src/index.mjs";
import { verifyPublicWebTrace } from "../../../tools/public-web-trace.mjs";
import { AT, freshStore, loadExampleSite } from "./fixtures.mjs";

function throwsCode(code, operation) { assert.throws(operation, (error) => error?.code === code); }

test("B57-R01 factory CLI validates and builds a deterministic static site", () => {
  const config = fileURLToPath(new URL("../config/site.example.json", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "ltm-public-web-cli-"));
  try {
    assert.equal(runCli(["verify", `--config=${config}`]).pageCount, 10);
    const report = runCli(["build", `--config=${config}`, `--out=${join(root, "site")}`]);
    assert.equal(report.status, "PASS");
    assert.equal(runCli(["inspect-build", `--config=${config}`, `--out=${join(root, "site")}`]).status, "PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R03 CLI refuses symlinked configuration and duplicate arguments", () => {
  const config = fileURLToPath(new URL("../config/site.example.json", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "ltm-public-web-cli-symlink-"));
  try {
    const link = join(root, "site.json");
    symlinkSync(config, link);
    throwsCode("CLI_INPUT_INVALID", () => runCli(["verify", `--config=${link}`]));
    throwsCode("CLI_ARGUMENT_INVALID", () => runCli(["verify", `--config=${config}`, `--config=${config}`]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R05 versioned store provides idempotency and tamper-evident audit", () => {
  const { root, store } = freshStore();
  try {
    const configuration = loadExampleSite();
    const input = { page: configuration.pages[0], actorId: "publisher-1", idempotencyKey: "same-request", at: AT };
    const first = publishLandingPage(store, input, configuration.site);
    const replay = publishLandingPage(store, input, configuration.site);
    assert.deepEqual(replay, first);
    assert.equal(store.read().revision, 1);
    const state = JSON.parse(readFileSync(store.path, "utf8"));
    state.audit[0].action = "page.delete";
    writeFileSync(store.path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    throwsCode("STORE_AUDIT_INVALID", () => store.read());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R05 local file store fsyncs and recovers only an expired dead-owner lease; production fails closed", () => {
  const { root, store } = freshStore();
  try {
    writeFileSync(store.lockPath, JSON.stringify({ schemaVersion: "ltm.public-web-lock.v1", ownerPid: 2_147_483_647, token: "stale-lock-token", acquiredAt: "2026-08-28T11:00:00.000Z" }), { mode: 0o600 });
    const configuration = loadExampleSite();
    assert.equal(publishLandingPage(store, { page: configuration.pages[0], actorId: "publisher-1", idempotencyKey: "stale-recovery", at: AT }, configuration.site).version, configuration.pages[0].version);
    throwsCode("STORE_BACKEND_UNSAFE", () => new VersionedMarketingStore(join(root, "production.json"), { mode: "production" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R01/B58-R01/B59-R01/B60-R01/B61-R01/B62-R01 factory trace binds all 30 canonical mandatory requirements", () => {
  const result = verifyPublicWebTrace();
  assert.equal(result.status, "PASS");
  assert.equal(result.requirementCount, 30);
  assert.equal(result.codeImplementationStatus, "PASSED");
  assert.equal(result.productionCertificationStatus, "NOT_CERTIFIED");
});
