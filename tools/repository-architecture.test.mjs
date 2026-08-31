import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { REQUIRED_SCHEMA7_FORCE_RLS_TABLES } from "./production-evidence-contracts.mjs";

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

test("PostgreSQL CI provisions every schema-7 runtime table and executes every durable service", async () => {
  const [workflow, manifest] = await Promise.all([
    source(".github/workflows/ci.yml"),
    source("infra/postgres/migrations/manifest.json").then(JSON.parse),
  ]);
  assert.equal(
    workflow.includes(`test "$(jq '.migrations.newlyApplied | length' .artifacts/postgres-migration-first.json)" -eq ${manifest.migrations.length}`),
    true,
    "CI first-run migration assertion must follow the checksum-bound manifest",
  );

  const grant = workflow.match(/GRANT SELECT,INSERT,UPDATE,DELETE ON ([^;]+) TO ltm_runtime;/)?.[1];
  assert.ok(grant, "CI must explicitly grant the runtime role its table surface");
  const grantedTables = grant.split(",").map((value) => value.trim().replace(/^ltm\./u, "")).sort();
  assert.deepEqual(grantedTables, [...REQUIRED_SCHEMA7_FORCE_RLS_TABLES].sort());
  const orchestrationGrant = workflow.match(/GRANT SELECT,INSERT,UPDATE,DELETE ON ([^;]+) TO ltm_runtime;/g)?.[1];
  assert.ok(orchestrationGrant, "CI must explicitly grant the orchestration runtime surface");
  const orchestrationTables = orchestrationGrant.match(/orchestration\.([a-z_]+)/gu)?.map((value) => value.slice("orchestration.".length)).sort();
  assert.deepEqual(orchestrationTables, [
    "dead_letters", "inbox", "late_provider_results", "outbox", "provider_executions",
    "scheduler_jobs", "workflow_history", "workflow_instances",
  ]);

  for (const workspace of [
    "@ltm/core",
    "@ltm/capabilities",
    "@ltm/api",
    "@ltm/data-intelligence",
    "@ltm/commerce-platform",
    "@ltm/growth-operations-platform",
    "@ltm/partner-channel-platform",
    "@ltm/orchestration-platform",
  ]) {
    assert.equal(workflow.includes(`pnpm --filter ${workspace} test`), true, `${workspace} is missing from live PostgreSQL CI`);
  }
});

test("artifact uploads explicitly include evidence stored under hidden directories", async () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/production-release-candidate.yml"]) {
    const workflow = await source(path);
    const lines = workflow.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]?.includes("uses: actions/upload-artifact@")) continue;
      let end = index + 1;
      while (end < lines.length && !/^      - /u.test(lines[end] ?? "")) end += 1;
      const step = lines.slice(index, end).join("\n");
      if (/path: \.artifacts(?:\/|$)/mu.test(step)) {
        assert.match(step, /include-hidden-files: true/u, `${path} excludes its hidden evidence path`);
      }
    }
  }
});
