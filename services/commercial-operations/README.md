# Commercial operations service

This package owns the dedicated B87-B102 finance, tax, print-production, vendor,
fulfilment, inventory, returns, and supplier-quality domain engines. It is not a
generic capability handler: every public command implements a named commercial
invariant and writes an immutable, tenant-scoped event through the durable
repository.

Production facts from payment processors, banks, tax platforms, vendors, and
carriers must arrive as `ltm.commercial-fact.v1` Ed25519 envelopes. Missing,
untrusted, replay-conflicting, or out-of-order facts fail closed. Local tests use
real signatures generated for the test process; production code has no synthetic
success provider.

The SQLite repository is suitable for the single-node deployment profile and
uses atomic idempotency records, optimistic aggregate versions, append-only
events, and checksum-bound schema metadata. Distributed deployments can provide
the same `CommercialOperationsRepository` contract using their transactional
database without changing domain rules.
