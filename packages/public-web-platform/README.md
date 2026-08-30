# Public Web Marketing Platform (B57-B62)

This package is the dedicated runtime for the `building-marketing-content-platform` Skill. It does not delegate the mandatory B57-B62 requirements to the generic capability registry.

## Runnable entrypoints

```sh
pnpm --filter @ltm/public-web-platform build
pnpm --filter @ltm/public-web-platform test
pnpm --filter @ltm/public-web-platform trace
node packages/public-web-platform/bin/public-web.mjs verify --config=packages/public-web-platform/config/site.example.json
node packages/public-web-platform/bin/public-web.mjs build --config=packages/public-web-platform/config/site.example.json --out=/absolute/safe/output/path
```

The builder parses closed JSON contracts, renders the ten required locale-prefixed page types, and emits canonical metadata, structured data, OG metadata, `sitemap.xml`, `robots.txt`, locale 404 pages, and governed redirects. Output roots cannot be the filesystem root, home directory, workspace root, or a workspace ancestor. Recursive replacement is allowed only for an output directory carrying its path-bound `.ltm-public-site-build.json` marker; non-managed files and symlinks fail closed.

The other modules provide file-backed idempotent state and tamper-evident audit chains for:

- landing publication, short-lived preview, and rollback;
- typed CMS workflow, translation drift, emergency withdrawal, ETag/cache invalidation, and media deletion protection;
- regional consent receipts, CSP/proxy/domain tag enforcement, automatic egress scans, withdrawal propagation, and server attribution;
- versioned campaigns, real QR encoding, allowlisted cross-platform deep links, immediate entry invalidation, and funnel health;
- consent/guardian/region/license-bound share assets, short-lived access, rate limits, crawler reduction, purge propagation, and synthetic media kits;
- licensed brand assets, mandatory trust claims, privacy-safe status/incident/subscription projections, receipt-bound notification delivery state, approval-bound sales assets, and dependency-drift invalidation.

## Production certification boundary

`requirements.trace.json` reports code implementation as `PASSED` while keeping production certification as `NOT_CERTIFIED`. Local deterministic tests cannot certify real DNS/CDN deployment, public SLO observations, professional legal/privacy/accessibility/security review, real CMP/ad/analytics integrations, downstream deletion receipts, executed licenses, independent certifications, notification delivery, or platform deep-link registration.

Production release automation must attach those independent artifacts and verify their digests. Missing, expired, withdrawn, or mismatched approvals, facts, licenses, consent, translations, tokens, providers, or dependencies fail closed. No production secret or real customer media belongs in configuration, fixtures, state, logs, or evidence.

## Operator recovery

- Bad page: publish a reviewed replacement or call `rollbackLandingPage`; preview versions never enter sitemap/public output.
- Bad CMS content: emergency-withdraw the published version, then `rollbackContentVersion`; rollback enters review and cannot republish without reapproval.
- Consent withdrawal: stop optional tags immediately, clear identifiers, enqueue downstream deletion, and record each processor receipt.
- Campaign incident: move the campaign to `paused` or `terminated`; old signed entries resolve to HTTP 410 with the recovery path.
- Share withdrawal: call `revokeShare`, purge every configured target, and show the external-cache caveat.
- Fact, certification, vendor, or policy change: reconcile dependencies and invalidate every resulting stale material/cache tag before public reuse.
