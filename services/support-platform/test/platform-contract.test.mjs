import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifySupportConfig, verifySupportTrace } from "../bin/support-platform.mjs";
import { createTicket, FileSupportStateStore } from "../src/index.mjs";
import { AT, auth, ticket } from "./fixtures.mjs";

test("support durable reference store survives reopen, preserves idempotency and rejects symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-support-state-"));
  try { const path = join(directory, "state.json"); const first = new FileSupportStateStore(path); first.initialize(); const input = { request: ticket(), authorization: auth("support-intake", "support-intake"), idempotencyKey: "durable-ticket", at: AT }; const created = createTicket(first, input); const reopened = new FileSupportStateStore(path); assert.deepEqual(createTicket(reopened, input), created); assert.equal(reopened.read().audit.length, 1); const link = join(directory, "state-link.json"); symlinkSync(path, link); assert.throws(() => new FileSupportStateStore(link).read(), (error) => error?.code === "STATE_FILE_INVALID"); } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("support config and canonical trace gates fail closed", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."); const config = JSON.parse(readFileSync(join(root, "config/platform.example.json"), "utf8")); assert.equal(verifySupportConfig(config).adapters, 7); assert.equal(verifySupportTrace().requirements, 40); assert.throws(() => verifySupportConfig({ ...config, environment: "production", state: { adapter: "memory", path: null } }), /durable file state/u); assert.throws(() => verifySupportConfig({ ...config, adapters: { ...config.adapters, crm: "https://crm.example/api-key" } }), /provider-config/u);
});
