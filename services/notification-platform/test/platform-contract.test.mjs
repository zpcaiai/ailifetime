import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyNotificationConfig, verifyNotificationTrace } from "../bin/notification-platform.mjs";
import { FileNotificationStateStore, savePreferences } from "../src/index.mjs";
import { AT, auth, preferences } from "./fixtures.mjs";

test("notification durable reference store survives reopen, preserves idempotency and rejects symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-notification-state-"));
  try { const path = join(directory, "state.json"); const first = new FileNotificationStateStore(path); first.initialize(); const input = { preferences: preferences(), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "durable-preferences", at: AT }; const saved = savePreferences(first, input); const reopened = new FileNotificationStateStore(path); assert.deepEqual(savePreferences(reopened, input), saved); assert.equal(reopened.read().audit.length, 1); const link = join(directory, "state-link.json"); symlinkSync(path, link); assert.throws(() => new FileNotificationStateStore(link).read(), (error) => error?.code === "STATE_FILE_INVALID"); } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("notification config and canonical trace gates fail closed", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."); const config = JSON.parse(readFileSync(join(root, "config/platform.example.json"), "utf8")); assert.equal(verifyNotificationConfig(config).providers, 5); assert.equal(verifyNotificationTrace().requirements, 30); assert.throws(() => verifyNotificationConfig({ ...config, environment: "production", state: { adapter: "memory", path: null } }), /durable file adapter/u); assert.throws(() => verifyNotificationConfig({ ...config, signing: { ...config.signing, callbackSecretReference: "plain-secret" } }), /secret-manager/u);
});
