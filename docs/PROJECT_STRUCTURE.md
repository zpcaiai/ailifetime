# Repository structure

This directory is the product Git repository. The versioned factory directory that contains it is a distribution container, not an additional application repository.

```text
.
├── apps/                 user-facing web, mobile, and WeChat surfaces
├── services/             deployable API, workers, and integration gateway
├── packages/             shared runtime, capabilities, providers, and SDKs
├── skills/               canonical 22-skill project catalog
├── infra/                database migrations and deployment contracts
├── security/             supply-chain and assurance policies
├── tools/                validation, smoke, backup, and release tooling
├── docs/                 architecture and operating documentation
├── evidence/             checked-in evidence schemas or public fixtures
├── .ai-life-time-machine/
│   ├── skill-package/    checksum-controlled factory support snapshot
│   └── state/            local orchestration state
└── .agents/skills -> ../skills
                          compatibility path for agent skill discovery
```

## Ownership rules

- `skills/` is the only editable, top-level project skill catalog. Each child directory contains its `SKILL.md`, references, and optional scripts or agent metadata.
- `.agents/skills` is a relative symbolic link. Tools that expect the Codex-compatible hidden path resolve the same files without maintaining a duplicate copy.
- `.ai-life-time-machine/skill-package` remains intact because factory manifests, checksums, and orchestration scripts resolve paths inside that support snapshot. It is not the canonical location for product edits.
- Generated state and runtime output stay in `.ai-life-time-machine/state`, `.data`, and `.artifacts`; they do not belong in application or skill source directories.
- Docker build contexts exclude the skill catalog and factory snapshot because runtime images need compiled application closures, not authoring instructions.

The installed factory manifest still records its package-owned files through `.agents/skills/...`; the compatibility link keeps those paths valid. Treat reinstall and uninstall commands as package-maintenance operations, not general-purpose cleanup. Review their target inventory before use so a vendor operation cannot silently replace product-owned canonical adaptations.

## Integrity checks

The top-level catalog must contain exactly 22 `SKILL.md` files. The vendor 2.0.0 snapshot remains byte-for-byte bound by its 317-entry checksum ledger; the canonical catalog may differ only through reviewed product-owned relocation and fail-closed certification adapters. Validate the vendor identity, canonical count, compatibility link, and executable adapters with:

```bash
test "$(find skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')" = 22
test -L .agents/skills
pnpm factory:validate
node --test tools/factory-status.test.mjs
```
