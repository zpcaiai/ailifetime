import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { DomainError } from "@ltm/core";
import { OidcAuthenticator } from "../dist/index.js";

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "oidc-test-key", alg: "RS256", use: "sig" });
  const resolver = createLocalJWKSet({ keys: [jwk] });
  const authenticator = new OidcAuthenticator({
    issuer: "https://identity.example.test",
    audience: "ltm-api",
    jwksUrl: new URL("https://identity.example.test/.well-known/jwks.json"),
    algorithms: ["RS256"],
    roleMap: { "ltm-consumer": "consumer" },
    stepUpAcrValues: ["urn:ltm:acr:mfa"],
    guardianVerifiedClaim: "guardian_verified",
  }, resolver);
  return { authenticator, privateKey };
}

async function token(privateKey, overrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1_000);
  const builder = new SignJWT({
    tenant_id: "tenant-oidc",
    roles: ["ltm-consumer"],
    permissions: ["record:create"],
    purposes: ["time_machine_generation"],
    acr: "urn:ltm:acr:mfa",
    guardian_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "oidc-test-key", typ: "at+jwt", ...headerOverrides })
    .setIssuer("https://identity.example.test")
    .setAudience("ltm-api")
    .setSubject("user-oidc")
    .setIssuedAt(now)
    .setExpirationTime(now + 300);
  return builder.sign(privateKey);
}

test("OIDC verifies signature/issuer/audience/type and maps only configured claims", async () => {
  const { authenticator, privateKey } = await fixture();
  const actor = await authenticator.authenticate({
    authorization: `Bearer ${await token(privateKey)}`,
    purpose: "time_machine_generation",
    requestId: "request-oidc-1",
  });
  assert.deepEqual(actor, {
    actorId: "user-oidc",
    tenantId: "tenant-oidc",
    roles: ["consumer"],
    permissions: ["record:create"],
    purpose: "time_machine_generation",
    requestId: "request-oidc-1",
    stepUp: true,
    guardianVerified: true,
  });
});

test("OIDC rejects unknown roles, wrong token type, and disallowed purpose", async () => {
  const { authenticator, privateKey } = await fixture();
  await assert.rejects(
    authenticator.authenticate({
      authorization: `Bearer ${await token(privateKey, { roles: ["unmapped-admin"] })}`,
      purpose: "time_machine_generation",
      requestId: "request-oidc-2",
    }),
    (error) => error instanceof DomainError && error.code === "AUTH_FORBIDDEN",
  );
  await assert.rejects(
    authenticator.authenticate({
      authorization: `Bearer ${await token(privateKey, {}, { typ: "JWT" })}`,
      purpose: "time_machine_generation",
      requestId: "request-oidc-3",
    }),
    (error) => error instanceof DomainError && error.code === "AUTH_UNAUTHENTICATED",
  );
  await assert.rejects(
    authenticator.authenticate({
      authorization: `Bearer ${await token(privateKey)}`,
      purpose: "unapproved_purpose",
      requestId: "request-oidc-4",
    }),
    (error) => error instanceof DomainError && error.code === "AUTH_FORBIDDEN",
  );
});
