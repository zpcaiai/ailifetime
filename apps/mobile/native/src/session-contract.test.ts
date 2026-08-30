import assert from "node:assert/strict";
import test from "node:test";
import { parseServerSession } from "./session-contract";

const response = {
  session: {
    actorId: "actor-1",
    tenantId: "tenant-1",
    roles: ["consumer"],
    purpose: "product_operation",
    stepUp: false,
    guardianVerified: false,
    authenticationState: "server_verified",
  },
  requestId: "request-12345678",
};

test("session parser consumes the exact GET /v1/session envelope", () => {
  assert.deepEqual(parseServerSession(response), {
    actorId: "actor-1", tenantId: "tenant-1", roles: ["consumer"], purpose: "product_operation", stepUp: false, guardianVerified: false,
  });
});

test("session parser rejects flat, client-asserted, or widened projections", () => {
  assert.throws(() => parseServerSession(response.session), /SERVER_SESSION_ENVELOPE_INVALID/);
  assert.throws(() => parseServerSession({ ...response, session: { ...response.session, sessionRevision: 1 } }), /SERVER_PRINCIPAL_INVALID/);
  assert.throws(() => parseServerSession({ ...response, session: { ...response.session, authenticationState: "client_asserted" } }), /SERVER_PRINCIPAL_INVALID/);
});
