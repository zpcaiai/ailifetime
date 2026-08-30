import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const candidateWorkflow = readFileSync(
  new URL("../.github/workflows/production-release-candidate.yml", import.meta.url),
  "utf8",
);

test("CI checkouts do not retain a repository write credential", () => {
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@[^\n]+\n(?<configuration>(?:\s+[^\n]*\n){0,4})/gu)];
  assert.equal(checkouts.length, 3);
  for (const checkout of checkouts) {
    assert.match(checkout.groups.configuration, /persist-credentials: false/u);
  }
});

test("untrusted pull-request code cannot reach OIDC or attestation write permissions", () => {
  const assurance = workflow.match(/  b123-security-assurance:\n(?<job>[\s\S]*?)(?=\n  b123-github-provenance:)/u)?.groups.job;
  assert.equal(typeof assurance, "string");
  assert.match(assurance, /permissions:\n\s+contents: read/u);
  assert.doesNotMatch(assurance, /security-events: write|id-token: write|attestations: write/u);

  const provenance = workflow.match(/  b123-github-provenance:\n(?<job>[\s\S]*)$/u)?.groups.job;
  assert.equal(typeof provenance, "string");
  assert.match(provenance, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(provenance, /needs: b123-security-assurance/u);
  assert.match(provenance, /id-token: write/u);
  assert.match(provenance, /attestations: write/u);
  assert.match(provenance, /actions\/download-artifact@[a-f0-9]{40} # v8/u);
  assert.match(provenance, /actions\/attest-build-provenance@[a-f0-9]{40} # v2/u);
});

test("every third-party workflow action is pinned to an immutable commit", () => {
  for (const [name, source] of [["verify", workflow], ["production candidate", candidateWorkflow]]) {
    const actions = [...source.matchAll(/uses:\s+([^\s@]+)@([^\s#]+)/gu)];
    assert.ok(actions.length > 0, `${name} workflow must use at least one action`);
    for (const action of actions) {
      assert.match(action[2], /^[a-f0-9]{40}$/u, `${name} action ${action[1]} is not commit pinned`);
    }
  }
});

test("protected production workflow renders a candidate but has no cluster mutation path", () => {
  assert.match(candidateWorkflow, /environment:\n\s+name: production-release-approval/u);
  assert.match(candidateWorkflow, /test "\$\{GITHUB_REF\}" = "refs\/heads\/main"/u);
  assert.match(candidateWorkflow, /persist-credentials: false/u);
  assert.match(candidateWorkflow, /kubectl kustomize/u);
  assert.doesNotMatch(
    candidateWorkflow,
    /kubectl\s+(?:apply|create|replace|delete|patch|rollout|scale)|helm\s+(?:install|upgrade|rollback)|KUBECONFIG|kubeconfig/u,
  );
  assert.match(candidateWorkflow, /It did not deploy, observe production, approve B127, or fabricate external certification evidence\./u);
});
