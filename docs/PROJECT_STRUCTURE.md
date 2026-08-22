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

The installed factory manifest still records its package-owned files through `.agents/skills/...`; the compatibility link keeps those paths valid. A forced factory reinstall is therefore allowed to replace the canonical catalog, and the factory uninstaller removes that catalog by design. Do not use either operation as a general-purpose cleanup command for hand-authored or third-party skills.

## Integrity checks

The top-level catalog must contain exactly 22 `SKILL.md` files and remain byte-identical to the installed factory snapshot until a deliberate skill-package upgrade is performed. Validate both the canonical and compatibility paths with:

```bash
test "$(find skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')" = 22
test -L .agents/skills
diff -qr skills .ai-life-time-machine/skill-package/skills
pnpm factory:validate
```
