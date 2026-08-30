# Notification lifecycle platform (B73–B78)

This package is the dedicated notification control plane. It implements preference and consent enforcement, quiet hours and frequency reservations, versioned message templates, five-channel provider interfaces, signed callbacks and unsubscribe links, executable lifecycle journeys, retries/DLQ/replay, sender governance, delivery facts, attribution experiments, and automatic guardrails. It does not use the generic capability registry as its business implementation.

## Runtime boundary

`NotificationStateStore` is the durable-state port. `FileNotificationStateStore` is the bounded, atomic, non-symlink reference implementation; `MemoryNotificationStateStore` is for deterministic unit tests. A production deployment should replace or wrap the file adapter with a transactionally equivalent database adapter without changing domain functions.

Real integrations implement `NotificationProviderAdapter`. The HTTP email, SMS, push, WeChat and in-app adapters send only secret-manager references to an injected credential-aware transport, require provider idempotency and authoritative receipt digests, and accept delivery callbacks only after HMAC/timestamp verification. `SandboxNotificationAdapter` always returns `productionEvidence: false` and cannot certify a real send.

The B76 worker sequence is `processJourneyEvent` → `claimDueJourneyTasks` → `advanceJourneyTask`. Node advancement executes trigger, approved-attribute condition/branch, wait, send-plan, goal and exit semantics, persists the next task, enforces per-node and journey send caps, and refuses stopped/revoked enrollments. Delivery is a separate provider transaction so a journey cannot claim a send based on intent alone.

## Commands

From this directory:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm trace
```

`verify-config` rejects inline secrets, non-HTTPS endpoints, incomplete channel inventory, memory state in production, and fabricated certification evidence. `verify-trace` binds every canonical B73–B78 requirement to an existing source symbol and a test containing the same requirement ID.

## Certification boundary

Code and contract tests are complete for all 30 mandatory requirements. The example config deliberately remains `NOT_CERTIFIED` for real provider delivery/read receipts, SPF/DKIM/DMARC and sender-account verification, production quota/failover/load observation, and legal/privacy review. Those gates may become `CERTIFIED` only with a repository-relative evidence path and lowercase SHA-256 digest. DNS records, provider accounts, credentials, real recipients, and professional approval cannot be manufactured by this package.
