# SDK API contract

The TypeScript, Python, and Java SDKs implement the dispatch contract in `services/api/openapi.yaml`. They accept a bearer access token plus a declared purpose. Tenant, actor, role, permissions, guardian verification, and step-up state are resolved by the server and are never sent as client assertions.

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
