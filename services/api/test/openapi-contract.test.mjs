import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMANDS, QUERIES } from "../dist/index.js";

const specification = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");

test("OpenAPI discriminates every executable command and query", () => {
  assert.match(specification, /CommandEnvelope:\n\s+oneOf:/);
  assert.match(specification, /QueryEnvelope:\n\s+oneOf:/);
  assert.doesNotMatch(specification, /OperationEnvelope:/);
  for (const command of COMMANDS) {
    assert.equal(
      specification.includes(`- ${command}`) || specification.includes(`const: ${command}`),
      true,
      `OpenAPI is missing command ${command}`,
    );
  }
  for (const query of QUERIES) {
    assert.equal(
      specification.includes(`- ${query}`) || specification.includes(`const: ${query}`),
      true,
      `OpenAPI is missing query ${query}`,
    );
  }
});

test("OpenAPI external business contracts are closed and cryptographically bound", () => {
  for (const schema of [
    "ExternalEventApplyEnvelope",
    "ExternalEventApplyInput",
    "VerifiedBusinessEvent",
    "SignedExternalEvidence",
    "ExternalCommandTransitionEnvelope",
    "ExternalCommandTransitionInput",
    "ExternalCommandGetEnvelope",
    "ExternalCommandRecord",
  ]) {
    const start = specification.indexOf(`    ${schema}:`);
    assert.notEqual(start, -1, `OpenAPI is missing schema ${schema}`);
  }
  assert.match(specification, /ExternalEventApplyInput:[\s\S]*?additionalProperties: false[\s\S]*?required: \[event, evidence\]/);
  assert.match(specification, /VerifiedBusinessEvent:[\s\S]*?const: ltm\.external-business-event\.v1/);
  assert.match(specification, /SignedBusinessEvidence:[\s\S]*?required: \[canonicalClaimsSha256, businessEventSha256\]/);
  assert.match(specification, /Sha256:[\s\S]*?pattern: '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(specification, /ExternalCommandRecord:[\s\S]*?reconciliation_required/);
});
