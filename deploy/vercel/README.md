# Vercel + Neon API deployment

## Reproducible deployment and secure launch inventory

The separate `ltm-album-save-test-01a1a064` project is an expiring synthetic
album transport fixture. Its repository-root build/entry is independent of this
production API. Do not point either project at the other's output, renew its test
credentials during a build, or deploy the shared dirty checkout.

From a verified clean checkout, with Node 26 and pnpm 10.12.4:

```sh
pnpm install --frozen-lockfile
pnpm --workspace-concurrency=1 --filter @ltm/api... build
# New absolute directories only. Default packaging omits production cron.
node tools/vercel-photo-package.mjs /absolute/new-preview-artifact
# Production explicitly retains the user-approved authenticated daily cleanup.
node tools/vercel-photo-package.mjs --production /absolute/new-production-artifact
```

Deploy only the artifact with the logged-in Vercel CLI and explicit
`--project ailifetime-private-api --scope zpchoney-6160s-projects`. Use preview
first; use `--prod` only after verifying production configuration and the
approved scheduler/plan. CLI packaging never reads deployment secrets or calls
Ark. Do not remove the cleanup schedule to bypass a hosting-plan restriction.
The user approved daily cleanup on2026-11-04, preserving the current plan and
the exact720-hour read deadline. No upgrade is authorized by packaging.

The live team inventory on2026-11-04 reports **Hobby**. The production schedule
is `15 11 * * *` UTC, daily at19:15 Asia/Shanghai, within Hobby's hourly timing
precision. TOS lifecycle independently expires stored photos after30days;
the application job drains eligible metadata and deletion retries, up to1000
objects or150seconds plus the final bounded object operation per invocation.
Backlog beyond those limits remains durable for a later invocation. This is not
an exact-second physical-erasure guarantee. Verify actual schedule registration
and invocation after deployment; source configuration alone is not execution.
See [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Use `node tools/seedream-launch-check.mjs` in an already secured server
environment, or pass `--names-json` with a variable-name-only inventory. It does
not print values and does not establish runtime readiness. Avoid `vercel env ls
--json`, which can expose non-sensitive values; use the dashboard's names view
and never export decrypted credentials into logs or a shared checkout.

See [Seedream safe setup and real generation acceptance](../../docs/SEEDREAM_PRO.md)
for the exact Vercel environment/file mappings and one-image validation process.
Missing dependencies keep readiness closed. Liveness/catalog responses and a
successful build do not prove an actual generated photo or production launch.

Status (2026-11-03): foundational backend deployed to `https://ailifetime-private-api.vercel.app` in the verified zpchoney account/team. Native Vercel CLI succeeded where the connected app returned403. Dedicated Neon Free resource `ailifetime-private-db` has seven core and two photo migrations applied and replay-verified. **BLOCKED_INCOMPLETE**: live/catalog return200, readiness and login return503 `BACKEND_NOT_CONFIGURED`; the user confirms production identity/payment/upload/model/storage services are not yet configured. No real model generation, phone login, cloud photo deletion or production business acceptance has passed. No custom API domain exists yet.

## Runtime and storage

Node26, Singapore function region, PostgreSQL connections with `sslmode=verify-full`. The current deployment uses a direct Neon connection and a dedicated non-owner runtime role with pool maximum2: the actual Neon transaction pooler rejects the core's `search_path=pg_catalog` startup protection. Direct connection preserves that protection; production concurrency/connection capacity still needs validation before business launch. Keep the existing production OIDC, signed consent, independent evidence, WeChat login/payment and upload broker gates. Do not replace these with a demo login or locally declared payment success.

The Neon resource remains on the account. Its automatic Vercel environment injection was disconnected after provisioning to remove all owner credentials; the API connects through its separately configured restricted `DATABASE_URL`. Migrator/owner credentials are retained only in private operator storage. Do not reconnect the automatic owner variables to the runtime. Both actual PostgreSQL18 cloud migration and PostgreSQL17 loopback replay pass; the migrator recognizes the exact PostgreSQL18 NOT NULL catalog constraints without dropping integrity checks.

New v3 lifespan orders: standard11/21 cost1990/2990 CNY cents, HD11/21 cost2990/4990 cents. Both age sets include0 and100; steps10 and5. Historical v1/v2 quotes retain990/4990 and their original immutable request. Seedream candidate generation pins `doubao-seedream-5-0-pro-260628`, PNG, `standard` prompt optimization and AI watermark. Standard is1536square; HD2048square. Quality binds the order, B14 plan/seed and provider request hash; output dimensions are checked both on received bytes and the signed publication boundary. The PostgreSQL intent is committed before the one paid POST. An interrupted request is `reconciliation_required`, not automatically re-billed. Candidate output still needs the existing signed B14/quality/safety publication pipeline; production worker routing and real provider validation remain outstanding.

Store generated originals and each derivative in a **private unversioned S3-compatible bucket**, with one journal entry per object and the same original completion time. Neon stores metadata/orders, not image bytes. The chosen object provider must support authenticated `GetBucketVersioning`; Enabled/Suspended or unsupported responses fail closed. Neon branchable storage lifecycle expiry is currently not implemented; do not rely on it or assume a soft delete removes historical copies. Actual storage credentials/provider acceptance are still required.

Photo access expires after720 hours from successful generation, checked against database time before and after reading bytes. The authenticated API streams verified bytes, sets no-store, and issues no reusable public URLs. The daily secret-protected cron claims one fenced object at a time and drains eligible expired objects within its object/time limits, deletes and checks absence. Physical removal is eventual after expiry; outages retain durable retry records. Never promise exact-second physical erasure or removal of pre-existing provider backups without separate proof. Do not enable bucket versioning, public ACLs, public CDN caching or backup/branch copies for this photo bucket.

## Configuration

Required existing production configuration: `LTM_AUTH_MODE=oidc`, issuer/audience/JWKS, signed consent catalog/trust, `LTM_EVIDENCE_TRUST_KEYS_JSON`, `LTM_METRICS_TOKEN_SHA256`, real WeChat identity/platform/upload broker URLs and workload tokens. See `services/api/src/config.ts` for the complete validated contract. Vercel encrypted broker token variables may use `LTM_WECHAT_IDENTITY_TOKEN`, `LTM_WECHAT_PLATFORM_BROKER_TOKEN`, `LTM_UPLOAD_BROKER_TOKEN`; the entry materializes owner-only temporary files for existing broker clients.

Photo service: `DATABASE_URL`, `LTM_PHOTO_S3_ENDPOINT`, `LTM_PHOTO_S3_REGION`, `LTM_PHOTO_S3_BUCKET`, `LTM_PHOTO_S3_ACCESS_KEY_ID`, `LTM_PHOTO_S3_SECRET_ACCESS_KEY`, and a random `CRON_SECRET` of at least32 characters. Seedream worker requires a server-side Ark key and verified source reader; never put API keys in mini-program `ext.json`.

Apply the existing core migrations first with the existing migrator, then `LTM_MIGRATOR_DATABASE_URL` and `node tools/photo-service-migrate.mjs`. The latter uses an advisory transaction lock and immutable checksum ledger. Use a dedicated app role with only required table/sequence permissions; keep owner/migrator credentials out of application environments.

## Packaging and gates

Run the API build and relevant HTTP/PostgreSQL/mini-program tests. `node tools/vercel-photo-package.mjs ABSOLUTE_NEW_DIRECTORY` creates an isolated artifact containing only the API bundle and dependency/configuration manifests. It preserves function names required by domain validation and intentionally omits cron; it cannot establish automatic retention. Actual first deployment was assigned Vercel target `production` and default aliases despite the CLI request for preview; record the returned target and aliases, not the requested label. This platform build status is not business readiness. Configure the user-approved daily production cron from `deploy/vercel/vercel.json` and verify the registered schedule plus authenticated invocation. No automatic plan upgrade is authorized.

Local gitignored mini-program `ext.json` now points development requests to the actual default HTTPS API. No release origin allowlist, WeChat server-domain enrollment or TLS/domain bypass was added. Original client code reaches the deployed catalog and receives the truthful missing-backend response for the session route; this transport probe is not a real wx.login or phone test.

For a fresh checkout, run `node apps/wechat-mini/tools/configure-api.mjs --api-base-url https://ailifetime-private-api.vercel.app` from the repository. The tool validates the actual project and public HTTPS origin, creates only non-secret gitignored ext configuration, and refuses to overwrite a different existing configuration. It does not enroll release origins or change WeChat server-domain settings. Login now shows readable unavailable/timeout messages and retains a closed `errorCode` for debugging instead of truncating every network failure to `request`.

The Vercel entry now composes the current API photo-quality service when scorer configuration is supplied, using the same validated scorer policy and private reader boundary as the ordinary server. Actual source-reader/provider/independent-quality integration and credentials still require production verification. CI runs the new storage/generation tests against disposable PostgreSQL, never the business Neon database.

Liveness and the public catalog can respond while `/health/ready` returns503 for missing production configuration. Liveness is not readiness. Before production: install/migrate dedicated Neon, bind verified private storage and trusted services, wire and test paid B14 generation, run cleanup/deletion recovery against the actual object provider, configure custom HTTPS API domain and WeChat server-domain lists, and measure login/upload/download on mainland phone carrier networks. Default `vercel.app` reachability is not proof of WeChat enrollment, review approval or mainland reliability.

Rollback only this task's patch using preserved preimages after comparing current hashes. Never restore over another chat's changes, delete cloud resources, lower auth/quality gates or silently re-price existing orders.

Official references: [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [streaming large responses](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions), [Seedream API](https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api), [Neon storage limitations](https://neon.com/docs/storage/troubleshooting).
