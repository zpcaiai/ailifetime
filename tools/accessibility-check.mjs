import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../apps/web/public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../apps/web/public/assets/styles.css", import.meta.url), "utf8");

const checks = [];
function check(name, operation) {
  operation();
  checks.push(name);
}

check("document language and landmarks", () => {
  assert.match(html, /<html lang="zh-CN"/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /class="skip-link" href="#main"/);
});

check("tabs expose names, controls, state, and keyboard focus", () => {
  assert.match(html, /role="tablist"/);
  const tabs = [...html.matchAll(/<button[^>]+role="tab"[^>]+>/g)].map((match) => match[0]);
  assert.equal(tabs.length, 4);
  for (const tab of tabs) {
    assert.match(tab, /aria-controls="[^"]+"/);
    assert.match(tab, /aria-selected="(?:true|false)"/);
    assert.match(tab, /tabindex="(?:0|-1)"/);
  }
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 4);
});

check("form controls have programmatic labels", () => {
  for (const id of ["tenantId", "actorId", "currentAge", "consent", "capability-search", "locale"]) {
    const labelled = new RegExp(`<label[^>]*>[\\s\\S]{0,180}(?:id="${id}"|for="${id}")`).test(html);
    assert.equal(labelled, true, `${id} is not labelled`);
  }
});

check("dialog and asynchronous status regions are named", () => {
  assert.match(html, /<dialog[^>]+aria-labelledby="capability-dialog-title"/);
  assert.match(html, /id="toast" role="alert" aria-live="assertive"/);
  assert.match(html, /id="connection" class="status" role="status"/);
});

check("focus, touch targets, reduced motion, and responsive breakpoints are explicit", () => {
  assert.match(css, /:focus-visible\{outline:3px solid/);
  assert.match(css, /button,select\{min-height:44px\}/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /@media\(max-width:800px\)/);
});

check("declared text colors meet WCAG AA contrast", () => {
  for (const [foreground, background, required] of [
    ["#61706d", "#f5f1e8", 4.5],
    ["#a33e25", "#f5f1e8", 4.5],
    ["#b84d35", "#ffffff", 4.5],
    ["#7c510e", "#f5f1e8", 4.5],
    ["#174f45", "#ffffff", 4.5],
  ]) {
    assert.ok(contrastRatio(foreground, background) >= required, `${foreground} on ${background} fails contrast`);
  }
});

console.log(JSON.stringify({ standard: "WCAG 2.1 AA automated subset", checks, passed: checks.length }, null, 2));

function contrastRatio(foreground, background) {
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
