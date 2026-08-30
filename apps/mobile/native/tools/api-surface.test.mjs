import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const protocolSources = [
  "src/session.ts",
  "src/services-context.tsx",
  "src/upload.ts",
  "src/push.ts",
  "src/iap.ts",
  "src/remote-config.ts",
  "app/editor.tsx",
  "app/library.tsx",
  "app/job/[id].tsx",
].map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");

test("native production code contains no phantom mobile, IAP, push, or projection routes", () => {
  for (const forbidden of [
    "/v1/mobile/session/bootstrap",
    "/v1/mobile/session/logout",
    "/v1/mobile/config",
    "/v1/mobile/iap/verify",
    "/v1/mobile/push/registrations",
    "/v1/mobile/navigation/",
    "/v1/queries/mobile/library",
    "/v1/queries/jobs/",
  ]) assert.equal(protocolSources.includes(forbidden), false, forbidden);
  for (const executable of [
    "/v1/session",
    "/v1/mobile/telemetry",
    "/v1/uploads",
    "/v1/capabilities/B07",
    "/v1/capabilities/B14",
  ]) assert.equal(protocolSources.includes(executable), true, executable);
});
