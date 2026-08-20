# AI Life Time Machine

Executable full-commercial reference implementation for the AI Life Time Machine project factory.

- Product profile: `full-commercial` (B00–B127)
- Stack profile: `all-typescript`
- Runtime: Node.js 26, strict TypeScript, SQLite local adapter, PostgreSQL production contract
- Safety boundary: illustrative AI content only; per-participant purpose consent; private by default; revocable shares; verifiable deletion; no biometric high-impact decisioning

## Run locally

```bash
pnpm install
pnpm check
pnpm start:local
```

Open `http://127.0.0.1:8080`. The local server binds only to loopback and accepts the fixed synthetic identity. Use `pnpm dev` instead for watch mode. Plain `pnpm start` stays fail-closed and requires server-side token configuration.

Run an API smoke test in another terminal:

```bash
pnpm smoke
```

Optional infrastructure contract:

```bash
docker compose config --quiet
docker compose up -d postgres redis object-storage
```

Build the production API image with `docker build -f services/api/Dockerfile .`. The image intentionally refuses to start until `LTM_API_TOKENS_JSON` supplies server-side principals.

The executable local runtime deliberately uses SQLite so build, tests and the core workflow do not depend on Docker. `infra/postgres/migrations/001_core.sql` defines the forced-RLS production persistence contract.

## Code map

- `packages/core` — authorization, tenant storage, consent, idempotency, audit, events and ledger
- `packages/capabilities` — 22 skill domains and all 128 batch handlers
- `packages/providers` — fail-closed external ports and synthetic-only sandbox adapters
- `services/api` — HTTP entrypoint, actor resolution and capability dispatch
- `services/workers` — leased outbox delivery with named worker routes and bounded retry
- `apps/web` — accessible consumer and operations console
- `apps/mobile`, `apps/wechat-mini` — mobile/offline/deep-link and WeChat security primitives
- `packages/sdk-ts`, `packages/sdk-python`, `packages/sdk-java` — integration clients
- `docs/ARCHITECTURE.md` — runtime and trust boundaries
- `docs/IMPLEMENTATION_STATUS.md` — exact code-level scope and deliberate framework/runtime boundaries
- `docs/EXTERNAL_GATES.md` — evidence that cannot be certified locally

## Validation

`pnpm check` runs strict type checks, package tests, Python SDK tests, Java SDK compilation and production builds. Capability tests compare the executable registry with the factory manifest so missing or duplicate B00–B127 implementations fail the build.

Factory state remains available through:

```bash
make factory-status
make factory-ready
```

Code-level implementation is not a B127 production certificate. Live AI quality, payment/IAP/WeChat, tax/fapiao, app-store review, printing/logistics, independent penetration testing, legal review, multi-region recovery and staged production rollout remain `NOT_CERTIFIED` or `NOT_RUN` until their named evidence exists.
