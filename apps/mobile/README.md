# Mobile application shell

`@ltm/mobile-core` is the dependency-free application layer shared by native iOS, Android, and cross-platform presentation adapters. It is executable TypeScript, not a static screen inventory. The package owns mobile lifecycle state, server-authorized navigation, capability execution, offline-command safety, native-store verification coordination, capture preflight, and deep-link policy.

## Production bootstrap

The application never creates a local user or persists an access token. A platform integration must inject:

- `MobileIdentityPort`: a real OIDC/OAuth native adapter. The adapter owns refresh credentials in Keychain/Keystore and returns only a bounded, short-lived access token plus expiry.
- `MobileOfflineLifecyclePort`: the existing `MobileOfflineQueue` satisfies this port. It binds queued work to the server-verified tenant/actor, drops legacy or different-account work, and is purged during sign-out.
- `MobileTelemetryPort`: a production telemetry adapter. Events are deliberately restricted to bounded operational fields and never receive access tokens.
- Optionally, `MobileApplicationApiPort`: use this for a separately managed native networking stack. Without it, `MobileHttpApiClient` calls the real API with injected `fetch`.

```ts
import { MobileApplication, MobileOfflineQueue } from "@ltm/mobile-core";

const offline = new MobileOfflineQueue(nativeSecureStorage);
const application = new MobileApplication({
  configuration: {
    environment: "production",
    platform: "ios",
    applicationId: "com.example.ltm.mobile",
    applicationVersion: "2.0.0",
    apiBaseUrl: "https://api.example.com",
    allowedApiOrigins: ["https://api.example.com"],
    purpose: "product_operation",
    allowedDeepLinkHosts: ["app.example.com"],
  },
  identity: nativeOidcAdapter,
  offline,
  telemetry: nativeTelemetryAdapter,
});

application.subscribe((snapshot) => nativeRenderer.render(snapshot));
await application.start();
```

Staging and production accept only an exact, enrolled public HTTPS origin.
Credentials, paths, queries, fragments, trailing slashes, IP literals,
loopback, single-label and reserved `.local`/`.test`/`.example`/`.invalid`
hosts fail configuration before networking. Development may explicitly enroll
an HTTP or HTTPS loopback origin.

Authorization becomes `ready` only after both `GET /v1/session` and `GET /v1/capabilities/visible` validate. The shell requires `authenticationState: server_verified`, exact schema `ltm.visible-capability-manifest.v1`, known roles/portals/modes, five capability requirements, unique identifiers, and consistent portal counts and skills. Unknown or inconsistent server projections clear every authorized surface and enter `failed`.

Capability and portal routes can only be opened from the server-visible projection. `executeCapability` rechecks visibility, requires an idempotency key, and sends the access token directly from memory. Snapshots, deep links, offline storage, and telemetry never expose it.

## Verification and certification boundary

```sh
pnpm --filter @ltm/mobile-core test
pnpm --filter @ltm/mobile-core typecheck
```

The browser-independent suite covers production configuration, signed-out startup, server authorization, routes/deep links, bearer non-observability, fail-closed projections, sign-out purge, real HTTP headers/envelopes, offline safety, store verification, and capture policy.

This package does not claim iOS/Android signing, device attestation, native OIDC provider acceptance, push entitlement, store review, or App Store/Play certification. Those remain external evidence gates for the concrete native application and release environment.
