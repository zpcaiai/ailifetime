import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, relative, resolve, sep } from "node:path";
import {
  boolean,
  enumValue,
  escapeHtml,
  exactKeys,
  fail,
  httpsUrl,
  identifier,
  integer,
  locale,
  optionalString,
  plainObject,
  requiredString,
  sanitizeText,
  sha256,
  signToken,
  stringArray,
  timestamp,
  verifyToken,
} from "./contracts.mjs";

export const REQUIRED_PAGE_KINDS = Object.freeze([
  "home",
  "product",
  "family",
  "future-self",
  "gift",
  "studio",
  "partner",
  "insurance-retirement-education",
  "pricing",
  "contact-sales",
]);

export const APPROVED_COMPONENT_TYPES = Object.freeze([
  "hero",
  "rich_text",
  "feature_grid",
  "cta",
  "faq",
  "pricing",
  "lead_form",
  "ai_disclosure",
  "trust_badges",
]);

const AI_DISCLOSURE = "AI-generated artistic simulation; illustrative, not predictive.";

function publicPath(value, label) {
  const normalized = requiredString(value, label, 512);
  if (
    !normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("//") ||
    normalized.includes("?") || normalized.includes("#") || normalized.split("/").some((part) => part === "." || part === "..") ||
    !/^\/[A-Za-z0-9/_-]*$/u.test(normalized)
  ) fail("PUBLIC_PATH_INVALID", `${label} must be a canonical public path`);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function nullableIdentifier(value, label) {
  return value === null ? null : identifier(value, label);
}

function validateComponent(value, index, allowedOrigins) {
  const component = plainObject(value, `components[${index}]`);
  exactKeys(component, ["id", "type", "text", "href", "formId"], `components[${index}]`);
  const id = identifier(component.id, `components[${index}].id`);
  const type = enumValue(component.type, APPROVED_COMPONENT_TYPES, `components[${index}].type`);
  const text = component.text === null ? null : sanitizeText(component.text, `components[${index}].text`, 10_000);
  let href = null;
  if (component.href !== null) {
    const raw = requiredString(component.href, `components[${index}].href`, 2_048);
    href = raw.startsWith("/") ? publicPath(raw, `components[${index}].href`) : httpsUrl(raw, `components[${index}].href`, { allowedOrigins }).toString();
  }
  const formId = component.formId === null ? null : identifier(component.formId, `components[${index}].formId`);
  if (type === "lead_form" && formId === null) fail("FORM_CONTRACT_INVALID", "lead_form requires a controlled formId");
  if (type !== "lead_form" && formId !== null) fail("FORM_CONTRACT_INVALID", "only lead_form may declare formId");
  if (type === "ai_disclosure" && (text === null || !text.includes("illustrative") || !text.includes("not predictive"))) {
    fail("AI_DISCLOSURE_REQUIRED", "AI disclosure cannot be hidden or weakened");
  }
  return { id, type, text, href, formId };
}

export function validateLandingPage(value, site) {
  const page = plainObject(value, "landing page");
  exactKeys(page, [
    "pageId", "version", "kind", "locale", "path", "title", "description", "canonicalUrl",
    "visibility", "dimensions", "components", "structuredData", "og", "aiDisclosure", "approvals", "publishedAt",
  ], "landing page");
  const allowedOrigins = stringArray(site.allowedOrigins, "site.allowedOrigins", { minimum: 1, maximum: 20, itemMaximum: 256 })
    .map((origin, index) => httpsUrl(origin, `site.allowedOrigins[${index}]`).origin);
  const normalizedLocale = locale(page.locale);
  const path = publicPath(page.path, "path");
  if (path !== `/${normalizedLocale}` && !path.startsWith(`/${normalizedLocale}/`)) {
    fail("I18N_PATH_INVALID", "published paths must be locale-prefixed");
  }
  const canonical = httpsUrl(page.canonicalUrl, "canonicalUrl", { allowedOrigins });
  if (canonical.pathname !== path || canonical.search !== "") fail("CANONICAL_MISMATCH", "canonical URL must equal the locale path without query parameters");
  const dimensions = plainObject(page.dimensions, "dimensions");
  exactKeys(dimensions, ["brand", "partner", "campaign", "region", "experiment"], "dimensions");
  const normalizedDimensions = {
    brand: identifier(dimensions.brand, "dimensions.brand"),
    partner: nullableIdentifier(dimensions.partner, "dimensions.partner"),
    campaign: nullableIdentifier(dimensions.campaign, "dimensions.campaign"),
    region: identifier(dimensions.region, "dimensions.region"),
    experiment: nullableIdentifier(dimensions.experiment, "dimensions.experiment"),
  };
  if (!Array.isArray(page.components) || page.components.length < 2 || page.components.length > 50) {
    fail("COMPONENT_SET_INVALID", "landing page must contain two to 50 approved components");
  }
  const components = page.components.map((component, index) => validateComponent(component, index, allowedOrigins));
  if (new Set(components.map((component) => component.id)).size !== components.length) fail("COMPONENT_SET_INVALID", "component IDs must be unique");
  if (!components.some((component) => component.type === "ai_disclosure")) fail("AI_DISCLOSURE_REQUIRED", "every marketing page requires the AI disclosure component");
  const structuredData = plainObject(page.structuredData, "structuredData");
  exactKeys(structuredData, ["type", "name", "description"], "structuredData");
  const normalizedStructuredData = {
    type: enumValue(structuredData.type, ["Organization", "Product", "FAQPage", "WebSite"], "structuredData.type"),
    name: sanitizeText(structuredData.name, "structuredData.name", 160),
    description: sanitizeText(structuredData.description, "structuredData.description", 500),
  };
  const og = plainObject(page.og, "og");
  exactKeys(og, ["title", "description", "imageUrl", "imageAlt"], "og");
  const normalizedOg = {
    title: sanitizeText(og.title, "og.title", 160),
    description: sanitizeText(og.description, "og.description", 300),
    imageUrl: httpsUrl(og.imageUrl, "og.imageUrl", { allowedOrigins }).toString(),
    imageAlt: sanitizeText(og.imageAlt, "og.imageAlt", 200),
  };
  const aiDisclosure = plainObject(page.aiDisclosure, "aiDisclosure");
  exactKeys(aiDisclosure, ["visible", "text"], "aiDisclosure");
  if (boolean(aiDisclosure.visible, "aiDisclosure.visible") !== true || sanitizeText(aiDisclosure.text, "aiDisclosure.text", 300) !== AI_DISCLOSURE) {
    fail("AI_DISCLOSURE_REQUIRED", `aiDisclosure must be visible and exactly: ${AI_DISCLOSURE}`);
  }
  const approvals = stringArray(page.approvals, "approvals", { minimum: 1, maximum: 10, itemMaximum: 64 });
  if (!approvals.includes("content")) fail("APPROVAL_REQUIRED", "page publication requires content approval");
  if (page.kind === "insurance-retirement-education" && !approvals.includes("legal")) {
    fail("APPROVAL_REQUIRED", "insurance, retirement, and education content requires legal approval");
  }
  return {
    pageId: identifier(page.pageId, "pageId"),
    version: identifier(page.version, "version"),
    kind: enumValue(page.kind, REQUIRED_PAGE_KINDS, "kind"),
    locale: normalizedLocale,
    path,
    title: sanitizeText(page.title, "title", 160),
    description: sanitizeText(page.description, "description", 500),
    canonicalUrl: canonical.toString(),
    visibility: enumValue(page.visibility, ["public", "preview", "retired"], "visibility"),
    dimensions: normalizedDimensions,
    components,
    structuredData: normalizedStructuredData,
    og: normalizedOg,
    aiDisclosure: { visible: true, text: AI_DISCLOSURE },
    approvals,
    publishedAt: page.publishedAt === null ? null : timestamp(page.publishedAt, "publishedAt"),
  };
}

export function publishLandingPage(store, input, site) {
  const page = validateLandingPage(input.page, site);
  if (page.visibility !== "public" || page.publishedAt === null) fail("PUBLICATION_STATE_INVALID", "published page must be public and timestamped");
  return store.transact({
    actorId: input.actorId,
    action: "page.publish",
    subject: page.pageId,
    idempotencyKey: input.idempotencyKey,
    input: page,
    at: input.at,
  }, (records) => {
    const aggregate = records.pages[page.pageId] ?? { versions: {}, currentVersion: null, history: [] };
    if (aggregate.versions[page.version] !== undefined && sha256(aggregate.versions[page.version]) !== sha256(page)) {
      fail("VERSION_IMMUTABLE", "page version already exists with different content");
    }
    aggregate.versions[page.version] = page;
    aggregate.currentVersion = page.version;
    aggregate.history.push({ operation: "published", version: page.version, at: input.at });
    records.pages[page.pageId] = aggregate;
    return { pageId: page.pageId, version: page.version, currentVersion: page.version, cacheTags: [`page:${page.pageId}`, `locale:${page.locale}`] };
  });
}

export function saveLandingPagePreview(store, input, site, secret, now = new Date()) {
  const page = validateLandingPage(input.page, site);
  if (page.visibility !== "preview" || page.publishedAt !== null) fail("PREVIEW_STATE_INVALID", "landing-page preview must be unpublished and preview-only");
  const editorId = identifier(input.editorId, "editorId");
  const ttlSeconds = integer(input.ttlSeconds, "ttlSeconds", 60, 900);
  const result = store.transact({
    actorId: input.actorId,
    action: "page.preview-save",
    subject: page.pageId,
    idempotencyKey: input.idempotencyKey,
    input: page,
    at: input.at,
  }, (records) => {
    const aggregate = records.pages[page.pageId] ?? { versions: {}, currentVersion: null, previewVersion: null, history: [] };
    const prior = aggregate.versions[page.version];
    if (prior !== undefined && sha256(prior) !== sha256(page)) fail("VERSION_IMMUTABLE", "page version already exists with different content");
    aggregate.versions[page.version] = page;
    aggregate.previewVersion = page.version;
    aggregate.history.push({ operation: "preview-saved", version: page.version, at: input.at, actorId: input.actorId });
    records.pages[page.pageId] = aggregate;
    return { pageId: page.pageId, version: page.version };
  });
  const iat = Math.floor(now.getTime() / 1_000);
  return {
    ...result,
    previewToken: signToken({ schemaVersion: "ltm.landing-preview.v1", audience: "landing-preview", pageId: page.pageId, version: page.version, editorId, iat, exp: iat + ttlSeconds }, secret),
  };
}

export function resolveLandingPagePreview(store, input, secret, now = new Date()) {
  const editorId = identifier(input.editorId, "editorId");
  const claims = verifyToken(input.token, secret, { schemaVersion: "ltm.landing-preview.v1", audience: "landing-preview", editorId }, now);
  const aggregate = store.read().records.pages[claims.pageId];
  const page = aggregate?.versions?.[claims.version];
  if (page === undefined || aggregate.previewVersion !== claims.version || page.visibility !== "preview") fail("PREVIEW_NOT_AVAILABLE", "landing-page preview is no longer available");
  return { page, html: renderPage(page, input.siteName), headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive" } };
}

export function rollbackLandingPage(store, input) {
  return store.transact({
    actorId: input.actorId,
    action: "page.rollback",
    subject: identifier(input.pageId, "pageId"),
    idempotencyKey: input.idempotencyKey,
    input: { pageId: input.pageId, targetVersion: input.targetVersion, reason: input.reason },
    at: input.at,
  }, (records) => {
    const aggregate = records.pages[input.pageId];
    if (aggregate === undefined) fail("PAGE_NOT_FOUND", "page does not exist");
    const targetVersion = identifier(input.targetVersion, "targetVersion");
    if (aggregate.versions[targetVersion] === undefined) fail("VERSION_NOT_FOUND", "rollback target does not exist");
    const reason = sanitizeText(input.reason, "reason", 500);
    const priorVersion = aggregate.currentVersion;
    aggregate.currentVersion = targetVersion;
    aggregate.history.push({ operation: "rolled_back", version: targetVersion, priorVersion, reason, at: input.at });
    return { pageId: input.pageId, priorVersion, currentVersion: targetVersion, reason };
  });
}

export function validateRedirects(value) {
  if (!Array.isArray(value) || value.length > 1_000) fail("REDIRECTS_INVALID", "redirects must be a bounded array");
  const fromPaths = new Set();
  return value.map((entry, index) => {
    exactKeys(entry, ["from", "to", "status"], `redirects[${index}]`);
    const from = publicPath(entry.from, `redirects[${index}].from`);
    const to = publicPath(entry.to, `redirects[${index}].to`);
    if (from === to || fromPaths.has(from)) fail("REDIRECTS_INVALID", "redirect sources must be unique and non-circular");
    fromPaths.add(from);
    return { from, to, status: integer(entry.status, `redirects[${index}].status`, 301, 308) };
  }).map((entry) => {
    if (![301, 308].includes(entry.status)) fail("REDIRECTS_INVALID", "only permanent 301 or 308 redirects are allowed");
    return entry;
  });
}

export function validateSiteConfiguration(value) {
  const site = plainObject(value, "site configuration");
  exactKeys(site, ["schemaVersion", "site", "pages", "redirects"], "site configuration");
  if (site.schemaVersion !== "ltm.public-site.v1") fail("SITE_SCHEMA_INVALID", "site schema version is unsupported");
  const settings = plainObject(site.site, "site");
  exactKeys(settings, ["name", "origin", "allowedOrigins", "locales", "defaultLocale", "requiredPageKinds"], "site");
  const allowedOrigins = stringArray(settings.allowedOrigins, "site.allowedOrigins", { minimum: 1, maximum: 20 })
    .map((origin, index) => httpsUrl(origin, `site.allowedOrigins[${index}]`).origin);
  const origin = httpsUrl(settings.origin, "site.origin", { allowedOrigins }).origin;
  const locales = stringArray(settings.locales, "site.locales", { minimum: 1, maximum: 20, itemMaximum: 16 }).map((item) => locale(item));
  const defaultLocale = locale(settings.defaultLocale, "site.defaultLocale");
  if (!locales.includes(defaultLocale)) fail("SITE_LOCALE_INVALID", "default locale must be included");
  const requiredPageKinds = stringArray(settings.requiredPageKinds, "site.requiredPageKinds", { minimum: REQUIRED_PAGE_KINDS.length, maximum: REQUIRED_PAGE_KINDS.length })
    .map((kind) => enumValue(kind, REQUIRED_PAGE_KINDS, "site.requiredPageKinds"));
  if (new Set(requiredPageKinds).size !== REQUIRED_PAGE_KINDS.length) fail("SITE_PAGE_SET_INVALID", "all required marketing page kinds must be declared");
  const normalizedSite = { name: sanitizeText(settings.name, "site.name", 100), origin, allowedOrigins, locales, defaultLocale, requiredPageKinds };
  if (!Array.isArray(site.pages) || site.pages.length === 0 || site.pages.length > 10_000) fail("SITE_PAGE_SET_INVALID", "pages must be a bounded non-empty array");
  const pages = site.pages.map((page) => validateLandingPage(page, normalizedSite));
  const publicPages = pages.filter((page) => page.visibility === "public");
  for (const configuredLocale of locales) {
    for (const kind of requiredPageKinds) {
      if (!publicPages.some((page) => page.locale === configuredLocale && page.kind === kind)) {
        fail("SITE_PAGE_SET_INCOMPLETE", `${configuredLocale} is missing public page kind ${kind}`);
      }
    }
  }
  const paths = publicPages.map((page) => page.path);
  if (new Set(paths).size !== paths.length) fail("SITE_PAGE_SET_INVALID", "public paths must be unique");
  const redirects = validateRedirects(site.redirects);
  for (const redirect of redirects) {
    if (!paths.includes(redirect.to)) fail("REDIRECT_TARGET_MISSING", `redirect target ${redirect.to} is not a public page`);
  }
  return { schemaVersion: "ltm.public-site.v1", site: normalizedSite, pages, redirects };
}

function outputPath(root, publicPathValue, extension = "index.html") {
  const relativePath = publicPathValue.replace(/^\//u, "");
  const target = resolve(root, relativePath, extension);
  const escaped = relative(root, target);
  if (escaped === ".." || escaped.startsWith(`..${sep}`)) fail("OUTPUT_PATH_ESCAPE", "site output escaped its root");
  return target;
}

function componentHtml(component) {
  const attributes = `data-component="${escapeHtml(component.type)}" id="${escapeHtml(component.id)}"`;
  const text = component.text === null ? "" : `<p>${escapeHtml(component.text)}</p>`;
  const href = component.href === null ? "" : `<a href="${escapeHtml(component.href)}">Learn more</a>`;
  const form = component.formId === null ? "" : `<form data-form-id="${escapeHtml(component.formId)}" method="post"><label>Email <input name="email" type="email" autocomplete="email" required></label><button type="submit">Contact us</button></form>`;
  return `<section ${attributes}>${text}${href}${form}</section>`;
}

export function renderPage(page, siteName) {
  const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@type": page.structuredData.type, name: page.structuredData.name, description: page.structuredData.description }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="${escapeHtml(page.locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(page.title)} | ${escapeHtml(siteName)}</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <link rel="canonical" href="${escapeHtml(page.canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(page.og.title)}">
  <meta property="og:description" content="${escapeHtml(page.og.description)}">
  <meta property="og:image" content="${escapeHtml(page.og.imageUrl)}">
  <meta property="og:image:alt" content="${escapeHtml(page.og.imageAlt)}">
  <meta name="robots" content="index,follow">
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>
  <a href="#main" class="skip-link">Skip to main content</a>
  <header><nav aria-label="Primary"><a href="/${escapeHtml(page.locale)}">${escapeHtml(siteName)}</a></nav></header>
  <main id="main"><h1>${escapeHtml(page.title)}</h1>${page.components.map(componentHtml).join("")}</main>
  <footer><p>${escapeHtml(page.aiDisclosure.text)}</p></footer>
</body>
</html>
`;
}

function isSameOrAncestor(candidate, target) {
  const path = relative(candidate, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function assertReplaceableBuildDirectory(root) {
  if ([parse(root).root, resolve(homedir())].includes(root) || isSameOrAncestor(root, resolve(process.cwd()))) {
    fail("OUTPUT_DIRECTORY_UNSAFE", "output directory cannot be a filesystem root, home directory, workspace root, or workspace ancestor");
  }
  if (!existsSync(root)) return;
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("OUTPUT_DIRECTORY_INVALID", "output must be a real directory");
  if (readdirSync(root).length === 0) return;
  const markerPath = resolve(root, ".ltm-public-site-build.json");
  if (!existsSync(markerPath)) fail("OUTPUT_DIRECTORY_NOT_MANAGED", "non-empty output is missing the public-site build marker");
  const markerMetadata = lstatSync(markerPath);
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink() || markerMetadata.size < 2 || markerMetadata.size > 4_096) {
    fail("OUTPUT_DIRECTORY_NOT_MANAGED", "public-site build marker must be a bounded regular file");
  }
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, "utf8")); }
  catch { fail("OUTPUT_DIRECTORY_NOT_MANAGED", "public-site build marker is invalid"); }
  if (
    marker?.schemaVersion !== "ltm.public-site-build-marker.v1" ||
    marker?.outputDirectorySha256 !== sha256(root) ||
    Object.keys(marker).sort().join(",") !== "outputDirectorySha256,schemaVersion"
  ) fail("OUTPUT_DIRECTORY_NOT_MANAGED", "public-site build marker is not bound to this directory");
}

export function buildStaticSite(configurationValue, outputDirectory) {
  const configuration = validateSiteConfiguration(configurationValue);
  const root = resolve(outputDirectory);
  assertReplaceableBuildDirectory(root);
  if (existsSync(root)) {
    rmSync(root, { recursive: true });
  }
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const files = [];
  const markerPath = resolve(root, ".ltm-public-site-build.json");
  writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: "ltm.public-site-build-marker.v1", outputDirectorySha256: sha256(root) }, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  files.push(".ltm-public-site-build.json");
  const publicPages = configuration.pages.filter((page) => page.visibility === "public");
  for (const page of publicPages) {
    const target = outputPath(root, page.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, renderPage(page, configuration.site.name), { encoding: "utf8", mode: 0o644 });
    files.push(relative(root, target));
  }
  for (const configuredLocale of configuration.site.locales) {
    const target = resolve(root, configuredLocale, "404.html");
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, `<!doctype html><html lang="${configuredLocale}"><title>Not found</title><main><h1>Page not found</h1><a href="/${configuredLocale}">Return home</a></main></html>\n`, { mode: 0o644 });
    files.push(relative(root, target));
  }
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${publicPages.map((page) => `  <url><loc>${escapeHtml(page.canonicalUrl)}</loc><lastmod>${page.publishedAt.slice(0, 10)}</lastmod></url>`).join("\n")}\n</urlset>\n`;
  writeFileSync(resolve(root, "sitemap.xml"), sitemap, { mode: 0o644 });
  writeFileSync(resolve(root, "robots.txt"), `User-agent: *\nDisallow: /preview/\nDisallow: /share/\nSitemap: ${configuration.site.origin}/sitemap.xml\n`, { mode: 0o644 });
  writeFileSync(resolve(root, "redirects.json"), `${JSON.stringify(configuration.redirects, null, 2)}\n`, { mode: 0o644 });
  files.push("sitemap.xml", "robots.txt", "redirects.json");
  const report = verifyBuiltSite(configuration, root);
  return { schemaVersion: "ltm.public-site-build.v1", outputDirectory: root, files: files.sort(), pageCount: publicPages.length, ...report };
}

export function verifyBuiltSite(configurationValue, outputDirectory) {
  const configuration = validateSiteConfiguration(configurationValue);
  const root = resolve(outputDirectory);
  const failures = [];
  const markerPath = resolve(root, ".ltm-public-site-build.json");
  if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink() || !lstatSync(markerPath).isFile()) {
    failures.push({ check: "build-integrity", path: ".ltm-public-site-build.json", code: "BUILD_MARKER_MISSING" });
  } else {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (marker.schemaVersion !== "ltm.public-site-build-marker.v1" || marker.outputDirectorySha256 !== sha256(root)) failures.push({ check: "build-integrity", path: ".ltm-public-site-build.json", code: "BUILD_MARKER_INVALID" });
    } catch { failures.push({ check: "build-integrity", path: ".ltm-public-site-build.json", code: "BUILD_MARKER_INVALID" }); }
  }
  const publicPaths = new Set(configuration.pages.filter((page) => page.visibility === "public").map((page) => page.path));
  for (const page of configuration.pages.filter((candidate) => candidate.visibility === "public")) {
    const target = outputPath(root, page.path);
    if (!existsSync(target)) failures.push({ check: "availability", path: page.path, code: "OUTPUT_MISSING" });
    for (const component of page.components) {
      if (component.href?.startsWith("/") && !publicPaths.has(component.href)) failures.push({ check: "link-integrity", path: page.path, target: component.href });
    }
  }
  for (const name of ["sitemap.xml", "robots.txt", "redirects.json"]) if (!existsSync(resolve(root, name))) failures.push({ check: "seo", path: name, code: "OUTPUT_MISSING" });
  failures.push(...auditBuiltAccessibility(configuration, root).failures);
  return { status: failures.length === 0 ? "PASS" : "FAIL", failures };
}

export function auditBuiltAccessibility(configurationValue, outputDirectory) {
  const configuration = validateSiteConfiguration(configurationValue);
  const root = resolve(outputDirectory);
  const failures = [];
  for (const page of configuration.pages.filter((candidate) => candidate.visibility === "public")) {
    const target = outputPath(root, page.path);
    if (!existsSync(target)) continue;
    const html = readFileSync(target, "utf8");
    const checks = [
      [html.includes(`<html lang="${page.locale}">`), "HTML_LANG_MISSING"],
      [html.includes('<a href="#main" class="skip-link">'), "SKIP_LINK_MISSING"],
      [html.includes('<main id="main"><h1>'), "MAIN_HEADING_MISSING"],
      [html.includes('<nav aria-label="Primary">'), "NAVIGATION_LABEL_MISSING"],
      [html.includes(escapeHtml(page.aiDisclosure.text)), "AI_DISCLOSURE_MISSING"],
    ];
    if (page.components.some((component) => component.type === "lead_form")) checks.push([/<form[^>]*>[\s\S]*<label>[\s\S]*<input[^>]+type="email"/u.test(html), "FORM_LABEL_MISSING"]);
    if (/<img\b(?![^>]*\balt=)[^>]*>/iu.test(html)) checks.push([false, "IMAGE_ALT_MISSING"]);
    for (const [passed, code] of checks) if (!passed) failures.push({ check: "accessibility", path: page.path, code });
  }
  return { schemaVersion: "ltm.public-site-accessibility-audit.v1", status: failures.length === 0 ? "PASS" : "FAIL", failures };
}

export function evaluatePublicSiteMonitoring(value) {
  const checks = plainObject(value, "monitoring input");
  exactKeys(checks, ["availability", "vitals", "seo", "links", "forms", "attribution"], "monitoring input");
  const vitals = plainObject(checks.vitals, "vitals");
  exactKeys(vitals, ["lcpMs", "inpMs", "cls"], "vitals");
  const failures = [];
  if (checks.availability !== "up") failures.push("availability");
  if (typeof vitals.lcpMs !== "number" || vitals.lcpMs > 2_500) failures.push("lcp");
  if (typeof vitals.inpMs !== "number" || vitals.inpMs > 200) failures.push("inp");
  if (typeof vitals.cls !== "number" || vitals.cls > 0.1) failures.push("cls");
  for (const field of ["seo", "links", "forms", "attribution"]) if (checks[field] !== "pass") failures.push(field);
  return {
    schemaVersion: "ltm.public-site-monitoring.v1",
    status: failures.length === 0 ? "healthy" : "degraded",
    failures,
    alertRequired: failures.length > 0,
  };
}

export const requiredAiDisclosure = AI_DISCLOSURE;
