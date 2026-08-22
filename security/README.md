# B123 security implementation

This directory contains executable security contracts and gates. The authoritative operator handoff is in `docs/security/B123-PRODUCTION-ASSURANCE.md`.

The native scanner is a fast repository guardrail. It is not CodeQL, Trivy, an independent penetration test, or a production certification. `tools/security-scan.mjs` returns `NOT_RUN` with exit code 2 until genuine secret-scan, CodeQL, pnpm-audit, Trivy config/image, and live DAST reports are supplied.

`security/pentest/trusted-providers.json` intentionally starts with no trusted provider keys. This deny-all state keeps B123-R04 `BLOCKED_EXTERNAL` until an independently procured assessor is enrolled and its signed report passes the evidence gate.

`tools/security-upstream-evidence.mjs` independently re-verifies the B119 configuration-change, B121 capacity-test, and B122 resilience-exercise production reports before they may support a B123/B127 release. It hashes the original report bytes, parses the same closed v1 report fields, reconstructs the exact capability evidence scope, verifies the Ed25519 envelope and production trust window, and rejects legacy client boolean assertions. `security/upstream-controls/trusted-keys.json` is intentionally empty, so missing real reports or issuer enrollment remains `BLOCKED_EXTERNAL`.
