# Project factory ownership

The product source lives at this Git repository root. The factory support bundle under `.ai-life-time-machine/skill-package` is a checksum-controlled vendor snapshot used by validation and orchestration tools; product code must not be placed inside it.

The canonical project skill catalog lives in `skills/`. `.agents/skills` is only a compatibility link for agent discovery. Product runtime code belongs in `apps/`, `services/`, and `packages/`; deployment and assurance code belongs in `infra/`, `security/`, and `tools/`.

Factory orchestration state records workflow progress, while executable tests and signed evidence determine implementation and release status. Neither scaffold state nor generated fixtures may be used as production certification.

See [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) for the complete ownership map.
