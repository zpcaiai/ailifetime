# SDK API contract

The TypeScript, Python, and Java SDKs implement the dispatch contract in `services/api/openapi.yaml`. They accept a bearer access token plus a declared purpose. Tenant, actor, role, permissions, guardian verification, and step-up state are resolved by the server and are never sent as client assertions.

## Authenticated discovery contract

Every SDK exposes typed `GET /v1/session`, `GET /v1/capabilities/visible`, and `GET /v1/capabilities` operations before dispatch. Session responses must be `server_verified` and use the exact requested purpose. Visible manifests must use `ltm.visible-capability-manifest.v1`; roles, seven portal identifiers, capability modes, five-item requirement lists, counts, unique identifiers, and portal-to-capability references are validated fail-closed. Catalog envelopes are closed to exactly `capabilities`, `count`, and `requestId`, and every entry is parsed into a typed `CapabilitySummary` rather than returned as raw JSON.

TypeScript:

```ts
import type { CapabilitySummary } from "@ltm/sdk";

const authenticated = await client.getSession();
const visible = await client.getVisibleCapabilityManifest();
const catalog: readonly CapabilitySummary[] = await client.listCapabilities();
console.log(authenticated.session.roles, visible.portals, catalog[0]?.operation);
```

Python:

```python
from ailifetime_sdk import CapabilitySummary

authenticated = client.get_session()
visible = client.get_visible_capability_manifest()
catalog: tuple[CapabilitySummary, ...] = client.list_capabilities()
print(authenticated.session.roles, visible.portals, catalog[0].operation)
```

Java 17+:

```java
import com.ailifetime.sdk.CapabilitySummary;
import java.util.List;

AuthenticatedSessionResponse authenticated = client.getSession();
VisibleCapabilityManifest visible = client.getVisibleCapabilityManifest();
List<CapabilitySummary> catalog = client.listCapabilities();
System.out.println(authenticated.session().roles() + " " + catalog.get(0).operation());
```

These operations return immutable/readonly typed projections. They do not infer identity or client-side permissions, and they reject unknown fields, unsupported schema versions, count drift, duplicate capability identifiers, or internally inconsistent visibility data.

## Signed consent policy contract

All three SDKs expose a typed consent-grant helper (`grantConsent` in TypeScript/Java and `grant_consent` in Python). The caller supplies only the participant, grantor capacity, exact resource/actions scope, purpose, policy version, optional expiry, and an optional disclosure acknowledgement digest. Jurisdiction, locale, minor status, disclosure content, and policy-catalog digest are server authority and are never accepted as SDK request fields. In production the API resolves the exact signed catalog rule and persists its server-derived disclosure digest and catalog/location binding.

```ts
await client.grantConsent({
  participantId: "participant-1",
  grantorCapacity: "self",
  purpose: "sharing",
  scope: { resource: "work:work-1", actions: ["share"] },
  policyVersion: "sharing-v1",
}, "consent-idempotency-key");
```

## Dispatch result contract

Commands, queries, and capability execution use the same response envelope on the wire:

```json
{
  "data": { "id": "record-1" },
  "meta": { "requestId": "req-1", "command": "record.create" }
}
```

The ordinary `execute`, `command`, and `query` methods consistently return only `data`. Use `executeEnvelope`/`execute_envelope`, `commandEnvelope`/`command_envelope`, or `queryEnvelope`/`query_envelope` when request correlation metadata is required. Java uses the same method names in camel case and returns the payload as `dataJson()` so it can remain dependency-free.

A successful HTTP response that is not a JSON object, omits `data` or `meta.requestId`, or reports a different batch/command/query in `meta` is rejected as `INVALID_RESPONSE`. The stable error contract is also validated rather than guessed:

```json
{
  "error": {
    "code": "CONSENT_REQUIRED",
    "message": "consent missing",
    "retryable": false,
    "details": {}
  },
  "requestId": "req-2"
}
```

## TypeScript

```ts
import { LifeTimeMachineClient } from "@ltm/sdk";

const client = new LifeTimeMachineClient({
  baseUrl: "https://api.example.com",
  session: { accessToken, purpose: "age_transformation" },
  timeoutMs: 10_000,
  maxRetries: 2,
});

const timeline = await client.execute<{ id: string }>("B14", input, crypto.randomUUID());
const created = await client.command<{ id: string }>(
  "record.create",
  { collection: "projects", data: { name: "Example" } },
  crypto.randomUUID(),
);
const records = await client.query<readonly { id: string }[]>("record.list", { collection: "projects" });
const correlated = await client.queryEnvelope("record.list", { collection: "projects" });
console.log(correlated.meta.requestId);
```

TypeScript validates every `execute`, `command`, and `query` input at runtime as a plain JSON object before networking. Top-level arrays/null values, non-plain prototypes, unsafe `__proto__`/`prototype`/`constructor` keys, accessors, cycles, sparse arrays, and non-finite numbers are rejected.

## Python

```python
from ailifetime_sdk import ClientSession, LifeTimeMachineClient

client = LifeTimeMachineClient(
    "https://api.example.com",
    ClientSession(access_token, "age_transformation"),
    timeout=10.0,
    max_retries=2,
)

timeline = client.execute("B14", payload, idempotency_key)
created = client.command("record.create", {"collection": "projects", "data": {}}, idempotency_key)
records = client.query("record.list", {"collection": "projects"})
correlated = client.query_envelope("record.list", {"collection": "projects"})
print(correlated.meta.request_id)
```

## Java 17+

```java
var session = new ClientSession(accessToken, "age_transformation");
var client = new LifeTimeMachineClient(
    URI.create("https://api.example.com"), session, Duration.ofSeconds(10), 2);

String timelineJson = client.execute("B14", inputJson, idempotencyKey);
String createdJson = client.command("record.create", createInputJson, idempotencyKey);
String recordsJson = client.query("record.list", listInputJson);
DispatchEnvelope correlated = client.queryEnvelope("record.list", listInputJson);
System.out.println(correlated.meta().requestId());
```

## Transport and retry guarantees

- HTTPS is required by default. Cleartext HTTP is accepted only for literal loopback/`localhost` development origins. Base URLs containing credentials, query strings, fragments, or path prefixes are rejected.
- Redirect following is disabled so bearer tokens cannot be forwarded to a different origin.
- The default timeout is 10 seconds, retries are bounded to 2 (configurable from 0 through 5), and response bodies are limited to 2 MiB (configurable up to 16 MiB).
- `Retry-After` is honored for retryable `429`/`5xx` responses, but the delay is capped at 5 seconds by default (configurable up to 60 seconds). A server error with `retryable: false` is never retried.
- Network and timeout failures are retried only for SDK operations known to be safe: GET requests, queries, or writes carrying a validated idempotency key. Capability execution and commands reject missing, control-character-containing, or over-200-character keys before any request is sent.
- TypeScript exposes `LifeTimeMachineTransportError`, Python exposes `TransportError`, and Java exposes `TransportException`; stable API failures use `LifeTimeMachineApiError`/`ApiError`/`ApiException` respectively.
- The SDKs send `Authorization`, `X-Purpose`, `X-Sdk-Version`, JSON content headers, and—only for idempotent writes—`Idempotency-Key`. They never send tenant, actor, role, or permission assertions.

The fixed `local-consumer` token exists only in explicit non-production synthetic mode. Deployed environments use opaque server-side token principals or verified OIDC/OAuth claims.

## Local contract verification

```sh
pnpm --filter @ltm/sdk test
PYTHONPATH=packages/sdk-python/src python3 -m unittest discover -s packages/sdk-python/tests -v
packages/sdk-java/test.sh
```

Each suite includes real loopback HTTP request/response tests plus malformed-success, structured-error, response-size, timeout/I/O, bounded `Retry-After`, identity-header, and idempotency negative cases. These checks validate the source packages; they do not claim publication to npm, PyPI, or Maven Central.
