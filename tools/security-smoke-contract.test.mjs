import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the B01 smoke uses a dedicated local administrator and architecture purpose", () => {
  const source = readFileSync(new URL("./smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /LTM_SMOKE_TOKEN \?\? "local-platform-admin"/u);
  assert.match(source, /LTM_SMOKE_PURPOSE \?\? "platform_architecture"/u);
  assert.match(source, /"x-purpose": purpose/u);
  assert.doesNotMatch(source, /age_transformation/u);
});
