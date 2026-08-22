import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SURFACE_SKILLS, PORTALS, localized, normalizeLocale, portalForSkill, translate } from "./surface.js";

test("browser bundle has the required web platform", () => {
  assert.equal(typeof URL, "function");
  assert.equal(typeof crypto.randomUUID, "function");
});

test("seven permission-aware portals cover all 22 capability domains exactly once", () => {
  assert.equal(PORTALS.length, 7);
  assert.equal(ALL_SURFACE_SKILLS.length, 22);
  assert.equal(new Set(ALL_SURFACE_SKILLS).size, 22);
  assert.equal(portalForSkill("building-finance-tax-operations")?.id, "operations");
  assert.equal(portalForSkill("building-developer-integration-platform")?.id, "developer");
});

test("locale negotiation and mandatory copy never return an empty legal surface", () => {
  assert.equal(normalizeLocale("zh-Hant"), "zh-TW");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale(undefined), "zh-CN");
  for (const portal of PORTALS) {
    for (const locale of ["zh-CN", "zh-TW", "en"] as const) {
      assert.notEqual(localized(portal.title, locale), "");
      assert.notEqual(localized(portal.description, locale), "");
      assert.notEqual(translate(locale, "disclaimer"), "");
      assert.notEqual(translate(locale, "boundaryConsent"), "");
      assert.notEqual(translate(locale, "productionReleaseDescription"), "");
    }
  }
});
