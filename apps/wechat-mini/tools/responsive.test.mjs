import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../miniprogram/", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", root), "utf8"));

test("the native window can resize and rotate without device model routing", () => {
  assert.equal(app.resizable, true);
  assert.equal(app.window.pageOrientation, "auto");
  assert.equal(app.tabBar.list.length, 4);
});

test("design lengths do not grow with the width of an unfolded display", () => {
  // A foldable's logical viewport can double while its pixel density stays the
  // same. Screen-relative fonts and fixed design lengths must not double too.
  const pages = process.env.LTM_RESPONSIVE_PAGES?.split(",") ?? app.pages;
  const files = ["app.wxss", ...pages.filter(Boolean).map((page) => `${page}.wxss`)];
  for (const file of files) {
    const css = readFileSync(new URL(file, root), "utf8");
    assert.doesNotMatch(css, /\d(?:rpx|vw)\b/, `${file}: use logical lengths for design details`);
  }
});

test("shared layout protects safe areas, readable widths and small touch targets", () => {
  const css = readFileSync(new URL("app.wxss", root), "utf8");
  for (const edge of ["left", "right", "bottom"]) {
    assert.ok(css.includes(`env(safe-area-inset-${edge})`), `missing ${edge} inset`);
  }
  assert.match(css, /max-width:\s*720px/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /flex-wrap:\s*wrap/);
  assert.match(css, /@media[^{}]*max-width:\s*360px/);
});
