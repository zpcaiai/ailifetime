# Production integration contract

1. Provision an absolute-path SQLite volume with single-writer ownership, encrypted storage, backups, and restore validation. The repository enables WAL, `synchronous=FULL`, busy timeout, immutable event/fact triggers, and a checksum-bound schema. A schema mismatch fails startup; no compatibility fallback exists.
2. Give the enterprise control-plane workload identity read-only access to one public authority catalog object. Do not inject private signing keys or live provider secrets.
3. Allocate separate Ed25519 authorities for build/scan evidence and independent authorities for penetration testing, game-day, legal filing, finding retest, regional runtime, and recertification. Authority grants enumerate exact environments, tenants, and fact kinds; wildcard kinds are invalid.
4. Treat `NOT_CERTIFIED` and `TEST_VERIFIED` as release-blocking wherever production certification is required. Only production facts can produce `CERTIFIED`.
5. Route every command with a tenant ID and stable idempotency key. Reusing a key with different canonical request content is a permanent conflict. A fact ID with changed content, or the same issuer/kind/subject/sequence under another ID, is rejected atomically.
6. Export `enterprise_events` through a read-only, tenant-scoped audit consumer. Do not update or delete event/fact rows; database triggers fail those operations.

The package intentionally contains no network client that fabricates cloud, CDN, scanner, pentest, regulator, or disaster-recovery success. Those systems integrate through signed facts after their real operation completes.
