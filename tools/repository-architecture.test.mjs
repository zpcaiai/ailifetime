import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("B01 local composition includes infrastructure, minimal app, and durable workflow worker", async () => {
  const [compose, packageJson, apiServer, workerHealth] = await Promise.all([
    source("compose.yaml"),
    source("package.json").then(JSON.parse),
    source("services/api/src/server.ts"),
    source("services/workers/src/health.ts"),
  ]);

  for (const service of ["api", "workflow-worker", "postgres", "redis", "object-storage"]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "m"), `missing ${service} compose service`);
  }
  assert.equal(packageJson.scripts["local:up"], "docker compose up --build --wait");
  assert.equal(packageJson.scripts["local:down"], "docker compose down");
  assert.match(compose, /condition: service_healthy/);
  assert.match(apiServer, /\/health\/live/);
  assert.match(apiServer, /\/health\/ready/);
  assert.match(workerHealth, /\/health\/live/);
  assert.match(workerHealth, /\/health\/ready/);
  assert.match(compose, /LTM_DEPLOYMENT_PROFILE: single-node/);
  assert.match(compose, /LTM_DATABASE_PATH: \/workspace\/\.data\/ltm-compose\.sqlite/);
});

test("B01 repository ownership protects every executable trust boundary", async () => {
  const codeowners = await source(".github/CODEOWNERS");
  for (const path of [
    "/apps/", "/packages/core/", "/packages/capabilities/", "/packages/providers/",
    "/services/workers/", "/services/integration-gateway/", "/services/client-integration-broker/",
    "/infra/", "/security/", "/tools/", "/skills/",
  ]) {
    assert.match(codeowners, new RegExp(`^${path.replaceAll("/", "\\/")}\\s+@`, "m"), `missing owner for ${path}`);
  }
});

test("B01 dependency direction keeps user interfaces away from database drivers", async () => {
  const manifests = await Promise.all([
    "apps/web/package.json",
    "apps/mobile/package.json",
    "apps/wechat-mini/package.json",
  ].map((path) => source(path).then(JSON.parse)));
  const forbidden = new Set(["pg", "postgres", "postgresql", "better-sqlite3", "sqlite", "sqlite3"]);
  for (const manifest of manifests) {
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const dependency of Object.keys(dependencies)) {
      assert.equal(forbidden.has(dependency), false, `${manifest.name} directly depends on database driver ${dependency}`);
    }
  }
});
