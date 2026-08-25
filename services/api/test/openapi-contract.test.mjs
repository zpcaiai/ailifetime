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
  assert.match(specification, /18 external-command batches resolve to 19 fixed signed callback contracts/);
  for (const schema of [
    "ExternalEventApplyEnvelope",
    "ExternalEventApplyInput",
    "VerifiedBusinessEvent",
    "SignedExternalEvidence",
    "ExternalCommandTransitionEnvelope",
    "ExternalCommandTransitionInput",
    "ExternalCommandGetEnvelope",
    "ExternalCommandRecord",
    "ShareGrantRevokeEnvelope",
    "ShareGrantGetEnvelope",
    "ShareGrantListEnvelope",
    "ShareGrantProjection",
  ]) {
    const start = specification.indexOf(`    ${schema}:`);
    assert.notEqual(start, -1, `OpenAPI is missing schema ${schema}`);
  }
  assert.match(specification, /ExternalEventApplyInput:[\s\S]*?additionalProperties: false[\s\S]*?required: \[event, evidence\]/);
  assert.match(specification, /VerifiedBusinessEvent:[\s\S]*?const: ltm\.external-business-event\.v1/);
  assert.match(specification, /SignedBusinessEvidence:[\s\S]*?required: \[canonicalClaimsSha256, businessEventSha256\]/);
  assert.match(specification, /Sha256:[\s\S]*?pattern: '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(specification, /ExternalCommandRecord:[\s\S]*?reconciliation_required/);
  assert.match(specification, /ShareGrantRevokeEnvelope:[\s\S]*?additionalProperties: false[\s\S]*?const: share-grant\.revoke/);
  assert.match(specification, /ShareGrantProjection:[\s\S]*?revocation_requested[\s\S]*?revoked/);
});

test("OpenAPI publishes authenticated session and server-filtered portal contracts", () => {
  assert.match(specification, /\/v1\/auth\/browser\/config:[\s\S]*?operationId: getBrowserOidcConfiguration/);
  assert.match(specification, /BrowserOidcConfiguration:[\s\S]*?additionalProperties: false[\s\S]*?ltm\.browser-oidc-config\.v1/);
  assert.match(specification, /BrowserOidcConfiguration:[\s\S]*?authorizationEndpoint[\s\S]*?tokenEndpoint[\s\S]*?redirectUri[\s\S]*?contains:\n\s+const: openid/);
  assert.match(specification, /\/v1\/session:[\s\S]*?operationId: getAuthenticatedSession/);
  assert.match(specification, /\/v1\/capabilities\/visible:[\s\S]*?operationId: listVisibleCapabilities/);
  assert.match(specification, /Capability:[\s\S]*?required: \[batchId, skill, operation, permission, portalId, mode,/);
  assert.match(specification, /AuthenticatedSession:[\s\S]*?const: server_verified/);
  assert.match(specification, /VisibleCapabilityCatalog:[\s\S]*?ltm\.visible-capability-manifest\.v1[\s\S]*?VisibleCapabilityPortal/);
  assert.match(specification, /\/v1\/consent-policy\/authority:[\s\S]*?operationId: getConsentPolicyAuthority/);
  assert.match(specification, /ConsentPolicyAuthorityResponse:[\s\S]*?additionalProperties: false[\s\S]*?catalogSha256/);
});

test("OpenAPI publishes WeChat identity and bounded resumable upload contracts", () => {
  for (const operationId of [
    "exchangeWechatLoginCode",
    "refreshClientSession",
    "revokeClientSession",
    "createResumableUpload",
    "appendResumableUploadChunk",
    "completeResumableUpload",
    "cancelResumableUpload",
  ]) assert.match(specification, new RegExp(`operationId: ${operationId}`));
  assert.match(specification, /WechatSessionRequest:[\s\S]*?additionalProperties: false/);
  assert.match(specification, /UploadCreateRequest:[\s\S]*?maximum: 26214400/);
  assert.match(specification, /UploadDigest:[\s\S]*?pattern: '\^\[a-f0-9\]\{64\}\$'[\s\S]*?const: sha256/);
  assert.match(specification, /ClientSession:[\s\S]*?accessToken:[\s\S]*?readOnly: true/);
  assert.doesNotMatch(specification, /ClientSession:[\s\S]*?accessToken:[\s\S]*?writeOnly: true/);
});

test("OpenAPI publishes the closed server-policy B05 deletion and per-target receipt contracts", () => {
  assert.match(specification, /B05CapabilityInput:[\s\S]*?additionalProperties: false[\s\S]*?required: \[assetId, reason\]/);
  assert.match(specification, /MediaDeletionProjection:[\s\S]*?additionalProperties: false[\s\S]*?targetReceipts/);
  assert.match(specification, /MediaDeletionTargetReceipt:[\s\S]*?ltm\.media-deletion-target-receipt\.v1[\s\S]*?policySha256/);
  assert.match(specification, /Caller-supplied policy or deletion-target fields are rejected/);
});
