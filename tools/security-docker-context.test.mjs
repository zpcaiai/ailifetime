import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PRODUCTION_DOCKERFILES = [
  "services/api/Dockerfile",
  "services/workers/Dockerfile",
  "services/integration-gateway/Dockerfile",
  "services/client-integration-broker/Dockerfile",
  "services/migrator/Dockerfile",
];

const REQUIRED_EXCLUSIONS = [
  ".artifacts",
  "**/.artifacts",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".npmrc",
  "**/.npmrc",
  ".pnpmrc",
  "**/.pnpmrc",
  ".yarnrc",
  ".yarnrc.*",
  "**/.yarnrc",
  "**/.yarnrc.*",
  ".netrc",
  "**/.netrc",
  "**/.docker/config.json",
  "**/*.db",
  "**/*.db-*",
  "**/*.sqlite",
  "**/*.sqlite-*",
  "**/*.sqlite3",
  "**/*.sqlite3-*",
  "apps/wechat-mini/project.private.config.json",
  "apps/wechat-mini/miniprogram/ext.json",
  "evidence/**/runtime/private",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.p8",
  "**/*.pk8",
  "**/*.pkcs8",
  "**/*.ppk",
  "**/*.jks",
  "**/*.jceks",
  "**/*.keystore",
  "**/*.crt",
  "**/*.cer",
  "**/*.cert",
  "**/*.der",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
];

const ALLOWED_NEGATIONS = new Set([
  "!.env.example",
  "!.env.*.example",
  "!**/.env.example",
  "!**/.env.*.example",
]);

function dockerIgnoreRules() {
  return readFileSync(".dockerignore", "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

test("root Docker build context excludes local credentials and private runtime evidence", () => {
  const rules = dockerIgnoreRules();
  for (const pattern of REQUIRED_EXCLUSIONS) {
    assert.ok(rules.includes(pattern), `.dockerignore must exclude ${pattern}`);
  }

  const negations = rules.filter((line) => line.startsWith("!"));
  assert.deepEqual(new Set(negations), ALLOWED_NEGATIONS);
  for (const [exclusion, example] of [
    [".env.*", "!.env.example"],
    [".env.*", "!.env.*.example"],
    ["**/.env.*", "!**/.env.example"],
    ["**/.env.*", "!**/.env.*.example"],
  ]) {
    assert.ok(rules.indexOf(example) > rules.indexOf(exclusion), `${example} must follow ${exclusion}`);
  }
});

test("every production Dockerfile copies the repository only behind the shared context policy", () => {
  const rules = dockerIgnoreRules();
  assert.ok(rules.includes(".git"));

  for (const file of PRODUCTION_DOCKERFILES) {
    const dockerfile = readFileSync(file, "utf8");
    assert.equal(
      [...dockerfile.matchAll(/^COPY \. \.$/gmu)].length,
      1,
      `${file} must have exactly one root-context COPY governed by .dockerignore`,
    );
  }
});

test("every production runtime uses the pinned package-manager-free distroless Node image", () => {
  const runtimeImage = "gcr.io/distroless/nodejs26-debian13:nonroot@sha256:10ec8cb93ef461563da50d4eb8dfac7d048783826825bf5b07510c2f34c14315";
  for (const file of PRODUCTION_DOCKERFILES) {
    const dockerfile = readFileSync(file, "utf8");
    assert.match(dockerfile, new RegExp(`^FROM ${runtimeImage} AS runtime$`, "mu"));
    assert.match(dockerfile, /^USER 10001:10001$/mu);
    assert.doesNotMatch(dockerfile.split(/^FROM .* AS runtime$/mu)[1] ?? "", /\b(?:npm|pnpm|corepack)\b/u);
  }
});
