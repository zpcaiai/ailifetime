# Test scope
`python3 tests/validate_package.py` and `python3 -m unittest discover -s tests -v` only test **package structure** and sample invariants.

Production app must separately implement and verify actual JSON Schema validation (e.g., Ajv or equivalent), PostgreSQL migrations, real jobs and renderer, concurrency, webhook signing, provider results, privacy deletion, content labels, visual regression and device testing.

Add `integration/`, `contract/`, `e2e/`, `security/`, `chaos/` suites to the eventual application repo; tests cannot be marked PASS unless run in declared environments with evidence.
