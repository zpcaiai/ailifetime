import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildStaticSite,
  auditBuiltAccessibility,
  evaluatePublicSiteMonitoring,
  publishLandingPage,
  resolveLandingPagePreview,
  rollbackLandingPage,
  saveLandingPagePreview,
  validateSiteConfiguration,
} from "../src/index.mjs";
import { AT, freshStore, loadExampleSite, NOW, SECRET } from "./fixtures.mjs";

function throwsCode(code, operation) {
  assert.throws(operation, (error) => error?.code === code);
}

test("B57-R01/B57-R02 composes all ten page kinds and emits SEO/i18n/404/redirect artifacts", () => {
  const configuration = loadExampleSite();
  const validated = validateSiteConfiguration(configuration);
  assert.equal(validated.pages.length, 10);
  assert.equal(new Set(validated.pages.map((page) => page.kind)).size, 10);
  const root = mkdtempSync(join(tmpdir(), "ltm-site-build-"));
  const output = join(root, "site");
  try {
    const report = buildStaticSite(configuration, output);
    assert.equal(report.status, "PASS");
    assert.equal(report.pageCount, 10);
    for (const file of [".ltm-public-site-build.json", "sitemap.xml", "robots.txt", "redirects.json", "en-US/404.html", "en-US/index.html"]) assert.equal(existsSync(join(output, file)), true);
    assert.equal(buildStaticSite(configuration, output).status, "PASS");
    const home = readFileSync(join(output, "en-US/index.html"), "utf8");
    assert.match(home, /rel="canonical"/u);
    assert.match(home, /application\/ld\+json/u);
    assert.match(home, /og:image:alt/u);
    assert.match(home, /Skip to main content/u);
    assert.doesNotMatch(readFileSync(join(output, "sitemap.xml"), "utf8"), /preview/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R03 builder rejects executable content and incomplete locale coverage", () => {
  const unsafe = loadExampleSite();
  unsafe.pages[0].components[0].text = "<script>alert(1)</script>";
  throwsCode("CONTENT_UNSAFE", () => validateSiteConfiguration(unsafe));
  const incomplete = loadExampleSite();
  incomplete.pages.pop();
  throwsCode("SITE_PAGE_SET_INCOMPLETE", () => validateSiteConfiguration(incomplete));
});

test("B57-R05 landing preview is short-lived, editor-bound, and excluded from public build", () => {
  const { root, store } = freshStore();
  try {
    const configuration = loadExampleSite();
    const page = { ...configuration.pages[0], pageId: "preview-home", version: "preview-v1", visibility: "preview", publishedAt: null };
    const issued = saveLandingPagePreview(store, { page, editorId: "editor-1", ttlSeconds: 120, actorId: "editor-1", idempotencyKey: "preview-save-1", at: AT }, configuration.site, SECRET, NOW);
    const preview = resolveLandingPagePreview(store, { token: issued.previewToken, editorId: "editor-1", siteName: "Life Time Machine" }, SECRET, new Date("2026-08-28T12:01:00.000Z"));
    assert.equal(preview.headers["x-robots-tag"], "noindex, nofollow, noarchive");
    assert.match(preview.html, /illustrative, not predictive/u);
    throwsCode("TOKEN_BINDING_MISMATCH", () => resolveLandingPagePreview(store, { token: issued.previewToken, editorId: "other-editor", siteName: "Life Time Machine" }, SECRET, NOW));
    throwsCode("TOKEN_EXPIRED", () => resolveLandingPagePreview(store, { token: issued.previewToken, editorId: "editor-1", siteName: "Life Time Machine" }, SECRET, new Date("2026-08-28T12:03:00.000Z")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R05 publication and rollback preserve immutable versions and audit chain", () => {
  const { root, store } = freshStore();
  try {
    const configuration = loadExampleSite();
    const first = configuration.pages[0];
    publishLandingPage(store, { page: first, actorId: "publisher-1", idempotencyKey: "page-publish-v1", at: AT }, configuration.site);
    const second = { ...structuredClone(first), version: "v2", title: "Life Time Machine 2" };
    publishLandingPage(store, { page: second, actorId: "publisher-1", idempotencyKey: "page-publish-v2", at: "2026-08-28T12:01:00.000Z" }, configuration.site);
    const result = rollbackLandingPage(store, { pageId: first.pageId, targetVersion: "v1", reason: "performance regression", actorId: "publisher-1", idempotencyKey: "page-rollback-1", at: "2026-08-28T12:02:00.000Z" });
    assert.equal(result.currentVersion, "v1");
    assert.equal(store.read().audit.length, 3);
    assert.equal(store.read().records.pages[first.pageId].versions.v2.title, "Life Time Machine 2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R04 monitoring degrades on Core Web Vitals or delivery failure", () => {
  assert.equal(evaluatePublicSiteMonitoring({ availability: "up", vitals: { lcpMs: 2_400, inpMs: 180, cls: 0.08 }, seo: "pass", links: "pass", forms: "pass", attribution: "pass" }).status, "healthy");
  const report = evaluatePublicSiteMonitoring({ availability: "down", vitals: { lcpMs: 3_000, inpMs: 250, cls: 0.2 }, seo: "fail", links: "fail", forms: "fail", attribution: "fail" });
  assert.equal(report.status, "degraded");
  assert.deepEqual(report.failures, ["availability", "lcp", "inp", "cls", "seo", "links", "forms", "attribution"]);
});

test("B57-R04 accessibility audit fails when keyboard navigation landmark is removed", () => {
  const configuration = loadExampleSite();
  const root = mkdtempSync(join(tmpdir(), "ltm-site-a11y-"));
  const output = join(root, "site");
  try {
    buildStaticSite(configuration, output);
    assert.equal(auditBuiltAccessibility(configuration, output).status, "PASS");
    const homePath = join(output, "en-US/index.html");
    writeFileSync(homePath, readFileSync(homePath, "utf8").replace('<a href="#main" class="skip-link">', "<a>"));
    const report = auditBuiltAccessibility(configuration, output);
    assert.equal(report.status, "FAIL");
    assert.equal(report.failures.some((failure) => failure.code === "SKIP_LINK_MISSING"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B57-R02 static builder refuses destructive workspace-root output", () => {
  throwsCode("OUTPUT_DIRECTORY_UNSAFE", () => buildStaticSite(loadExampleSite(), process.cwd()));
  const root = mkdtempSync(join(tmpdir(), "ltm-site-unmanaged-"));
  try {
    const unmanaged = join(root, "existing");
    writeFileSync(unmanaged, "preserve me", { mode: 0o600 });
    throwsCode("OUTPUT_DIRECTORY_INVALID", () => buildStaticSite(loadExampleSite(), unmanaged));
    assert.equal(readFileSync(unmanaged, "utf8"), "preserve me");
    rmSync(unmanaged);
    const directory = join(root, "existing-directory");
    mkdirSync(directory);
    writeFileSync(join(directory, "keep.txt"), "preserve me", { mode: 0o600 });
    // A non-empty real directory without the bound marker is never recursively replaced.
    throwsCode("OUTPUT_DIRECTORY_NOT_MANAGED", () => buildStaticSite(loadExampleSite(), directory));
    assert.equal(readFileSync(join(directory, "keep.txt"), "utf8"), "preserve me");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
