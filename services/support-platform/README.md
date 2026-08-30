# Customer support and success platform (B79–B86)

This package is the dedicated support, CRM and customer-success control plane. It implements versioned knowledge/search, ticket threading/SLA routing/escalation, quarantined attachments, an approved-knowledge support assistant, minimized human handoff, customer 360 and audited support sessions, two-person support actions, data-rights processor workflows, partner CRM/quotes, onboarding/health/offboarding, surveys, quality review, training and VOC remediation. It does not delegate these workflows to a generic configuration handler.

## Runtime boundary

`SupportStateStore` is the durable-state port. `FileSupportStateStore` provides bounded atomic persistence, an audit hash chain, request idempotency and non-symlink reads; `MemorySupportStateStore` is the deterministic reference adapter used by tests. Tenant, role, purpose, step-up and training checks run inside domain entry points and again at state mutation boundaries.

External systems implement `IdentityVerificationAdapter`, `AttachmentScanner`, `SupportToolExecutor`, `SupportDomainCommandAdapter`, `DataRightsWorkflowAdapter`, and `PartnerOffboardingAdapter`. The included reference adapters are executable contract simulators and always mark external receipts `productionEvidence: false`. Refunds, credits, reprints, shipping changes, provider work, deletion/export, credential revocation, accounting settlement and CRM sync are never represented as complete merely because a local record changed.

Sensitive flows are fail-closed: raw media/private conversations/payment credentials are excluded from customer summaries; attachments are quarantine-only and short-token accessed; refund/replacement/address changes require step-up and governed approvals; data-rights completion requires every named processor receipt; support sessions forbid secrets, consent acceptance, privilege elevation and private-conversation export; surveys suppress child/crisis/privacy contexts; health scoring rejects face and emotion inference.

## Commands

From this directory:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm trace
```

`verify-config` rejects inline secrets, ungoverned adapters, non-durable production state and fabricated evidence. `verify-trace` binds every canonical B79–B86 requirement to a dedicated source symbol and named test.

## Certification boundary

Code and contract tests are complete for all 40 mandatory requirements. Real malware-scanner/object-store receipts, payment/order/fulfilment/CRM/data-rights/offboarding provider receipts, real support-agent training records, production SLA observations, and professional legal/privacy/child-safety/regulatory review remain `NOT_CERTIFIED`. These gates can change only after repository-relative evidence and its lowercase SHA-256 digest are supplied; the reference adapters cannot clear them.
