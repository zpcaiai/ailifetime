# SDK authentication contract

All SDKs accept a bearer access token plus a declared purpose. Tenant, actor, role, permissions, guardian verification and step-up state are resolved by the server and are never sent as client assertions.

TypeScript:

```ts
import { LifeTimeMachineClient } from "@ltm/sdk";

const client = new LifeTimeMachineClient({
  baseUrl: "http://127.0.0.1:8080",
  session: { accessToken: "local-consumer", purpose: "age_transformation" },
});

const result = await client.execute("B14", input, crypto.randomUUID());
```

Python:

```python
from ailifetime_sdk import ClientSession, LifeTimeMachineClient

client = LifeTimeMachineClient(
    "http://127.0.0.1:8080",
    ClientSession("local-consumer", "age_transformation"),
)
result = client.execute("B14", payload, idempotency_key)
```

Java:

```java
var session = new ClientSession("local-consumer", "age_transformation");
var client = new LifeTimeMachineClient(
    URI.create("http://127.0.0.1:8080"), session, Duration.ofSeconds(10), 2);
var result = client.execute("B14", jsonBody, idempotencyKey);
```

The fixed `local-consumer` token exists only in explicit non-production synthetic mode. Deployed environments configure opaque server-side token principals or replace that adapter with verified OIDC/OAuth claims.
