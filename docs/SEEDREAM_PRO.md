# Seedream Pro generation integration

The ordinary API and Vercel API can compose the official Ark adapter, pinned to
`doubao-seedream-5-0-pro-260628`. This is a **candidate generation integration**,
not certification of identity, realistic aging, safety, or the complete B14/B15
product. Enabling it does not automatically call a paid model.

## Server configuration

Set `LTM_SEEDREAM_ENABLED=true`. Supply either `ARK_API_KEY` through the server's
secret manager, or `LTM_SEEDREAM_API_KEY_FILE` pointing to an absolute, regular,
owner-only file (0600; no symlink). Do not supply both. Never put these values in
mini-program code, `ext.json`, a browser, Git, screenshots or logs. Omit the flag
or set it to `false` to disable generation.

Also configure:

- `DATABASE_URL`: the existing application PostgreSQL database. Staging and
  production require `sslmode=verify-full`. Apply existing core migrations and
  `node tools/photo-service-migrate.mjs` with the separate migrator credential;
  do not migrate at request time. The app role needs existing photo-service
  table permissions, not schema ownership or database administration.
- `LTM_UPLOAD_BROKER_URL`, `LTM_UPLOAD_BROKER_TOKEN_FILE`: existing approved upload
  broker HTTPS origin and workload credential. Its media-download authorizer,
  original objects and current revocation/lifecycle checks must be operational.
- `LTM_PHOTO_S3_ENDPOINT`, `LTM_PHOTO_S3_REGION`, `LTM_PHOTO_S3_BUCKET`,
  `LTM_PHOTO_S3_ACCESS_KEY_ID`, `LTM_PHOTO_S3_SECRET_ACCESS_KEY`: the existing private,
  **unversioned** generated-media bucket. Configure the existing retention
  cleanup separately; see [private storage deployment](../deploy/vercel/README.md).
- Existing authentication, signed consent, evidence and scorer configuration
  remains mandatory for the respective workflow. A passing `/health/live` or
  product catalog does not prove readiness. `/health/ready` also checks enabled
  generation's SQL tables, object store and source broker, without paid inference.

Ordinary server and Vercel use the same composition. Vercel supports encrypted
`LTM_UPLOAD_BROKER_TOKEN` by materializing the existing owner-only temporary token
file. No production endpoint override or automatic provider fallback is offered.

## Provider-controller workflow

The existing B14/outbox provider controller, using an authenticated service
account with `media.generation.generate`, calls one bounded node at a time:

```http
POST /v1/timelines/{stored-command-id}/generate
Authorization: Bearer <service-account-token>
X-Purpose: age_transformation
Idempotency-Key: <operation-key>
Content-Type: application/json

{"targetAge": 40}
```

The command must already exist, be active, and contain that age in its stored
plan. The handler derives the tenant, media owner, original accepted B07 source,
participants, composition, age instructions, prompt policy and resolution from
server records. It rechecks each person's current transform consent, command
cancellation, parent/retry binding and plan before external egress and after
generation. Caller prompts, source URLs, models, prices and quality assertions
are rejected. Consumer tokens cannot use this service endpoint.

For 11- or 21-node albums, the controller calls this endpoint for each stored
target age, serially or within its existing approved budget/concurrency limits.
The HTTP handler never launches unawaited work, creates an independent background
loop, or starts a whole album on an arbitrary client request. Deploy/configure
the existing trusted provider controller separately; merely enabling this API
does not dispatch pending outbox commands.

Every age uses the original authorized reference, rather than the previous AI
output. Couple positions follow the stored participant mapping. Wardrobe edits
add the accepted age image as a second reference and require separate wardrobe
consent; the original identity reference remains first. Standard output is
1536×1536; HD/default is 2048×2048. PNG, standard prompt optimization and AI
watermark stay enabled. The local plan seed is **provenance only**: this adapter
does not claim deterministic seeded replay from Ark or pass an undocumented
provider seed parameter.

The response contains candidate asset metadata, completion time, model, source
digest, plan digest, policy version and plan seed. It explicitly returns
`status: candidate` and `publishable: false`. It returns no public image URL.
Candidates still need independent byte-bound B15 scoring, B17 safety, and the
existing trusted, signed `generation-engine` B14 delivery. Only that accepted
delivery exposes consumer download paths. Neither API credentials nor generated
pixels are treated as evidence that a quality/safety gate passed.

## Replay, uncertainty and rollback

The PostgreSQL intent is committed before the single Ark POST. Its durable key
is derived from tenant, actual media owner, command and age, independently of
the caller's HTTP key or which service instance processes the request. The
fingerprint binds the full stored plan and actual provider request. Concurrent
requests do not generate twice. A completed operation rereads and validates its
private stored object, including retention; it does not bill again.

Transport loss, timeout, invalid provider bytes or interrupted persistence leaves
an executing/reconciliation-required intent. **Do not delete the row, change the
HTTP key, or automatically resubmit.** Reconcile it using the provider console
and storage/SQL evidence. A new user-authorized single-node retry must use the
existing retry-command path and budget rules; it is a distinct operation. An
expired generated image is unavailable and never silently regenerated.

Disable `LTM_SEEDREAM_ENABLED` to stop new generation requests. Existing signed
deliveries, source authorization, media retention and deletion continue to apply.
Roll back only this change's commits after checking for concurrent edits; do not
delete objects/journal evidence or weaken publication gates.

## Verification boundary

Local tests execute real HTTP, PostgreSQL journals, SQLite application/consent
logic and filesystem image bytes; the remote Ark boundary returns explicitly
synthetic non-person pixels. They cover single/couple ages, the complete 0–100
21-node plan, wardrobe references, replay, stream loss, cancelled/withdrawn
authority, consumer refusal and publication refusal. The scoring handoff retains
the actual source owner's identity when reading private images.

Reproduce with Node 26 and pnpm 10.12.4 after installing/building dependencies:

```sh
pnpm --filter @ltm/api... run build
APP_ENV=test LTM_PHOTO_TEST_POSTGRES_URL='<disposable PostgreSQL URL>' \
  node --test --test-concurrency=1 services/api/test/seedream*.test.mjs \
  services/api/test/timeline-seedream.test.mjs
```

Real paid Ark inference, authorized-person quality comparison, deployed broker
and object-store acceptance, provider-controller dispatch and WeChat device
acceptance are **NOT_RUN / NOT_CERTIFIED** by these tests. Do not interpret a
local test pass or Git merge as those external acceptances.

Official contract: [Ark image generation API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh&redirect=1).
