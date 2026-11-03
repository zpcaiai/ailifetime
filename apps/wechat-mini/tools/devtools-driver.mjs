import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const observers = new WeakMap(), routeQueues = new WeakMap();

export class NativeContextNotReadyError extends Error {
  constructor(report) {
    super(`NATIVE_CONTEXT_UNAVAILABLE at ${report.phase}: ${report.reason}; no native scenario was started`);
    this.name = "NativeContextNotReadyError";
    this.report = report;
  }
}

export async function verifyNativeContext(mini, options = {}) {
  let phase = "raw_page";
  try {
    return await withDeadline("native context readiness", async () => {
      const raw = await mini.send("App.getCurrentPage");
      phase = "sdk_page";
      const page = await mini.currentPage();
      phase = "logic_stack";
      const logical = await mini.evaluate(function () {
        const page = getCurrentPages().slice(-1)[0];
        return page ? { path: page.route, pageId: page.__wxWebviewId__ } : null;
      });
      if (typeof raw?.path !== "string" || !raw.path || raw.path !== page?.path || raw.path !== logical?.path) throw new Error("NATIVE_CONTEXT_PATH_MISMATCH");
      if (!Number.isInteger(Number(raw.pageId)) || raw.pageId == null || page.id == null || logical.pageId == null || Number(raw.pageId) !== Number(page.id) || Number(raw.pageId) !== Number(logical.pageId)) throw new Error("NATIVE_CONTEXT_PAGE_ID_MISMATCH");
      phase = "rendered_root";
      if (!await page.$(".page")) throw new Error("NATIVE_CONTEXT_ROOT_MISSING");
      return { status: "READY", path: raw.path, pageId: Number(raw.pageId) };
    }, options.timeoutMs);
  } catch (error) {
    throw new NativeContextNotReadyError({ status: "UNAVAILABLE", phase, reason: error.message });
  }
}

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

async function observer(mini, options) {
  if (observers.has(mini)) return observers.get(mini);
  const owner = randomUUID();
  await withDeadline("install native route observer", () => mini.evaluate(function (owner) {
    if (global.__ltmDevtoolsRouting) throw new Error("NATIVE_ROUTE_OBSERVER_ALREADY_OWNED");
    if (["onAppRoute", "offAppRoute", "onAppRouteDone", "offAppRouteDone"].some(name => typeof wx[name] !== "function")) throw new Error("NATIVE_ROUTE_EVENTS_UNAVAILABLE");
    const state = { owner, sequence: 0, route: null, done: {}, operations: {}, history: [], closed: false, error: "" };
    const record = (event, done) => {
      if (state.closed) return;
      if (!event || typeof event.path !== "string" || typeof event.routeEventId !== "string" || !event.routeEventId || !Number.isInteger(Number(event.webviewId))) { state.error = "NATIVE_ROUTE_EVENT_INVALID"; return; }
      const key = [event.path, event.webviewId, event.routeEventId].join(":");
      const value = { path: event.path, webviewId: Number(event.webviewId), routeEventId: event.routeEventId, sequence: ++state.sequence, key };
      if (done) state.done[key] = value; else state.route = value;
      state.history.push({ ...value, phase: done ? "done" : "route" });
      if (state.history.length > 64) {
        const removed = state.history.shift();
        if (removed.phase === "done" && removed.key !== state.route?.key) delete state.done[removed.key];
      }
    };
    state.onRoute = event => record(event, false); state.onDone = event => record(event, true);
    wx.onAppRoute(state.onRoute); wx.onAppRouteDone(state.onDone);
    global.__ltmDevtoolsRouting = state;
    return true;
  }, owner), options.timeoutMs);
  observers.set(mini, owner);
  return owner;
}

async function snapshot(mini, owner, operation, options) {
  return withDeadline("read native route state", () => mini.evaluate(function (owner, operation) {
    const state = global.__ltmDevtoolsRouting;
    if (!state || state.owner !== owner) throw new Error("NATIVE_ROUTE_OBSERVER_OWNERSHIP_LOST");
    return { sequence: state.sequence, route: state.route, done: state.route && state.done[state.route.key],
      idle: !state.route || !!state.done[state.route.key], error: state.error, operation: operation ? state.operations[operation] : null };
  }, owner, operation), options.timeoutMs);
}

async function idle(mini, owner, options) {
  return waitForState("native route idle", async () => {
    const state = await snapshot(mini, owner, null, options);
    if (state.error) throw new Error(state.error);
    return state.idle ? state : false;
  }, options);
}

function serialize(mini, action) {
  const previous = routeQueues.get(mini);
  const next = previous ? previous.then(action, action) : Promise.resolve().then(action);
  routeQueues.set(mini, next);
  return next.finally(() => { if (routeQueues.get(mini) === next) routeQueues.delete(mini); });
}

async function completedPage(mini, owner, expected, initial, sequence, operation, options) {
  return waitForState(`route ${expected}`, async () => {
    const state = await snapshot(mini, owner, operation, options);
    if (state.error) throw new Error(state.error);
    if (state.operation?.error) throw new Error(state.operation.error);
    if (operation && !state.operation?.complete) return false;
    if (!state.idle || (!state.route || state.route.sequence <= sequence) && initial !== expected) return false;
    if (state.route && state.route.path !== expected) return false;
    const raw = await mini.send("App.getCurrentPage"), page = await mini.currentPage();
    if (raw.path !== expected || page?.path !== expected || state.route && Number(raw.pageId) !== state.route.webviewId) return false;
    return await page.$(".page") ? page : false;
  }, options);
}

export async function navigate(mini, kind, url, options = {}) {
  if (!["switchTab", "navigateTo"].includes(kind) || typeof url !== "string" || !url.startsWith("/pages/")) throw new Error("UNSUPPORTED_NATIVE_ROUTE");
  return serialize(mini, async () => {
    const owner = await observer(mini, options), before = await idle(mini, owner, options);
    const initial = (await mini.currentPage()).path, operation = randomUUID();
    try {
      await withDeadline("dispatch route", () => mini.evaluate(function (owner, operation, kind, url) {
        const state = global.__ltmDevtoolsRouting;
        if (!state || state.owner !== owner) throw new Error("NATIVE_ROUTE_OBSERVER_OWNERSHIP_LOST");
        // Callbacks close over this exact operation; a late callback cannot
        // acknowledge a later request to the same path.
        const receipt = { complete: false, error: "" }; state.operations[operation] = receipt;
        wx[kind]({ url, fail: error => { receipt.error = error?.errMsg || "NATIVE_ROUTE_FAILED"; }, complete: () => { receipt.complete = true; } });
        return true;
      }, owner, operation, kind, url), options.timeoutMs);
      return await completedPage(mini, owner, url.split("?", 1)[0].slice(1), initial, before.sequence, operation, options);
    } finally {
      await withDeadline("release native route receipt", () => mini.evaluate(function (owner, operation) {
        const state = global.__ltmDevtoolsRouting;
        if (!state || state.owner !== owner) throw new Error("NATIVE_ROUTE_OBSERVER_OWNERSHIP_LOST");
        delete state.operations[operation]; return true;
      }, owner, operation), options.timeoutMs);
    }
  });
}

export async function tapAndWaitForRoute(mini, name, element, url, options = {}) {
  if (!element || typeof element.tap !== "function" || typeof url !== "string" || !url.startsWith("/pages/")) throw new Error("NATIVE_ROUTE_TARGET_INVALID");
  return serialize(mini, async () => {
    const owner = await observer(mini, options), before = await idle(mini, owner, options);
    await withDeadline(`tap ${name}`, () => element.tap(), options.timeoutMs);
    // Gestures must produce a new matching route/done pair, even if a stale
    // same-path completion was already recorded before the tap.
    return completedPage(mini, owner, url.split("?", 1)[0].slice(1), "", before.sequence, null, options);
  });
}

export async function disposeRouteObserver(mini, options = {}) {
  const owner = observers.get(mini); if (!owner) return;
  const history = await withDeadline("dispose native route observer", () => mini.evaluate(function (owner) {
    const state = global.__ltmDevtoolsRouting;
    if (!state) return [];
    if (state.owner !== owner) throw new Error("NATIVE_ROUTE_OBSERVER_OWNERSHIP_LOST");
    state.closed = true; wx.offAppRoute(state.onRoute); wx.offAppRouteDone(state.onDone);
    delete global.__ltmDevtoolsRouting; return state.history;
  }, owner), options.timeoutMs);
  observers.delete(mini);
  return history;
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
