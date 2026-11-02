import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

export async function withDeadline(name, action, timeoutMs = 8000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("INVALID_NATIVE_DEADLINE");
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function waitForState(name, observe, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error("INVALID_NATIVE_POLL_INTERVAL");
  return withDeadline(name, async () => {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      const value = await withDeadline(name, observe, Math.max(1, end - performance.now()));
      if (value) return value;
      await sleep(Math.min(intervalMs, Math.max(1, end - performance.now())));
    }
    throw new Error(`${name} timed out after ${timeoutMs}ms`);
  }, timeoutMs);
}

export async function navigate(mini, kind, url, options = {}) {
  if (!["switchTab", "navigateTo"].includes(kind) || typeof url !== "string" || !url.startsWith("/pages/")) throw new Error("UNSUPPORTED_NATIVE_ROUTE");
  // Route callbacks can lag behind visible navigation in DevTools. Dispatch the
  // actual wx API, then require the actual page and rendered root to converge.
  await withDeadline("dispatch route", () => mini.evaluate(function (method, target) {
    wx[method]({ url: target });
    return true;
  }, kind, url), options.timeoutMs);
  const expected = url.split("?", 1)[0].slice(1);
  return waitForState(`route ${expected}`, async () => {
    const page = await mini.currentPage();
    return page?.path === expected && await page.$(".page") ? page : false;
  }, options);
}

export async function buttonByText(page, text) {
  const buttons = await withDeadline("button collection", () => page.$$("button"));
  if (!Array.isArray(buttons)) throw new Error("SDK_ELEMENT_COLLECTION_INVALID");
  for (const button of buttons) {
    if ((await withDeadline("button text", () => button.text())).trim() === text) return button;
  }
  return null;
}

export async function tapAndWait(name, element, observe, options = {}) {
  if (!element || typeof element.tap !== "function") throw new Error(`NATIVE_ELEMENT_MISSING: ${name}`);
  await withDeadline(`tap ${name}`, () => element.tap(), options.timeoutMs);
  return waitForState(name, observe, options);
}

export async function cleanupOwnedSession(mini, token, options = {}) {
  await withDeadline("check owned fixture session", () => mini.evaluate(function (token) {
    const current = require("services/session.js").get();
    if (!current || current.accessToken !== token) throw new Error("CONCURRENT_USER_SESSION_PRESERVED");
    return true;
  }, token), options.timeoutMs);
  // A covered authenticated page may run onShow while the stack is popped.
  // Clearing first can send that page to auth during the home-tab transition.
  try { await navigate(mini, "switchTab", "/pages/home/index", options); }
  finally {
    const cleared = await withDeadline("clear owned fixture session", () => mini.evaluate(function (token) {
      const session = require("services/session.js"), current = session.get();
      if (current && current.accessToken !== token) throw new Error("CONCURRENT_USER_SESSION_PRESERVED");
      session.clear();
      return session.get() === null;
    }, token), options.timeoutMs);
    if (cleared !== true) throw new Error("OWNED_FIXTURE_SESSION_NOT_CLEARED");
  }
}
