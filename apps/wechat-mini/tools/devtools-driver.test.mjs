import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import * as driver from "./devtools-driver.mjs";
import { buttonByText, cleanupOwnedSession, navigate, tapAndWait, waitForState, withDeadline } from "./devtools-driver.mjs";

// These test the SDK transport boundary. Real native execution is a separate CLI run.
test("a missing RPC callback fails with the operation name instead of hanging", async () => {
  await assert.rejects(withDeadline("screenshot", () => new Promise(() => {}), 15), /screenshot.*timed out/);
  assert.equal(await withDeadline("read", async () => 21, 100), 21);
});

test("a rejected native RPC retains its actual failure", async () => {
  const failure = new Error("native route rejected");
  await assert.rejects(withDeadline("route", async () => { throw failure; }, 100), error => error === failure);
});

test("state polling waits for an observable change and rejects a missing change", async () => {
  let count = 0;
  assert.equal(await waitForState("render", async () => ++count === 3 && "rendered", { timeoutMs: 100, intervalMs: 1 }), "rendered");
  await assert.rejects(waitForState("checkbox", async () => false, { timeoutMs: 15, intervalMs: 1 }), /checkbox.*timed out/);
});

test("button lookup uses the SDK collection API, not its single-element API", async () => {
  const target = { text: async () => "  停止后续保存  " };
  const page = { $() { throw Error("single element is not iterable"); }, $$: async selector => {
    assert.equal(selector, "button"); return [{ text: async () => "保存全部就绪原图" }, target];
  } };
  assert.equal(await buttonByText(page, "停止后续保存"), target);
  assert.equal(await buttonByText(page, "missing"), null);
  await assert.rejects(buttonByText({ $$: async () => target }, "停止后续保存"), /SDK_ELEMENT_COLLECTION_INVALID/);
});

test("navigation verifies the actual page and DOM without awaiting the SDK route callback wrapper", async () => {
  const remote = routeTransport();
  const page = await navigate(remote.mini, "switchTab", "/pages/capture/index", { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(page.path, "pages/capture/index");
  assert.equal(await page.$(".page") !== null, true);
  assert.deepEqual(remote.events, ["navigate", "done"]);
});

test("dispatched navigation and matching logical path cannot pass without a rendered page", async () => {
  const remote = routeTransport({ dom: false });
  await assert.rejects(navigate(remote.mini, "switchTab", "/pages/capture/index", { timeoutMs: 60, intervalMs: 1 }), /route.*timed out/);
  await assert.rejects(navigate(remote.mini, "close", "/pages/capture/index"), /UNSUPPORTED_NATIVE_ROUTE/);
});

test("native tap acknowledgment cannot pass until its event changes observable state", async () => {
  let taps = 0, observations = 0;
  const element = { tap: async () => { taps++; } };
  assert.equal(await tapAndWait("cancel", element, async () => ++observations > 2, { timeoutMs: 100, intervalMs: 1 }), true);
  assert.equal(taps, 1);
  await assert.rejects(tapAndWait("denied", element, async () => false, { timeoutMs: 15, intervalMs: 1 }), /denied.*timed out/);
});

function sessionTransport({ rejectRoute = false, changeAccount = false } = {}) {
  return routeTransport({ rejectRoute, changeAccount, initialPath: "pages/wardrobe/index" });
}

test("cleanup navigates while its exact owned session is valid, then verifies removal", async () => {
  const remote = sessionTransport();
  await cleanupOwnedSession(remote.mini, "owned", { timeoutMs: 1000, intervalMs: 1 });
  assert.deepEqual(remote.events, ["navigate", "done", "clear"]);
  assert.equal(remote.session.get(), null);
});

test("cleanup failure still removes the owned fixture session and retains the route error", async () => {
  const remote = sessionTransport({ rejectRoute: true });
  await assert.rejects(cleanupOwnedSession(remote.mini, "owned"), /native route rejected/);
  assert.equal(remote.session.get(), null);
});

test("cleanup cannot erase an account that changed during native navigation", async () => {
  const remote = sessionTransport({ changeAccount: true });
  await assert.rejects(cleanupOwnedSession(remote.mini, "owned"), /CONCURRENT_USER_SESSION_PRESERVED/);
  assert.equal(remote.session.get().accessToken, "other-user");
  assert.deepEqual(remote.events, ["navigate", "done"]);
});

// SDK transport fixture only: it deliberately exposes the logical page before
// route animation completes, as captured in the real DevTools route trace.
function routeTransport({ neverDone = false, staleDone = false, dom = true, rejectRoute = false, changeAccount = false, initialPath = "pages/home/index", supported = true, wrongRawView = false } = {}) {
  let path = initialPath, id = 1, sequence = 0, pending = false, current = { accessToken: "owned" };
  const listeners = { route: new Set(), done: new Set() }, events = [];
  const emit = (name, value) => { for (const listener of listeners[name]) listener(value); };
  const session = { get: () => current, clear: () => { events.push("clear"); current = null; } };
  const wx = {
    onAppRoute: fn => listeners.route.add(fn), offAppRoute: fn => listeners.route.delete(fn),
    onAppRouteDone: supported ? fn => listeners.done.add(fn) : undefined, offAppRouteDone: fn => listeners.done.delete(fn),
  };
  function dispatch(input) {
    if (!current) throw Error("AUTH_REDIRECT_RACE");
    if (rejectRoute) throw Error("native route rejected");
    if (pending) throw Error("NATIVE_TRANSITIONS_OVERLAPPED");
    events.push("navigate");
    const target = input.url.split("?", 1)[0].slice(1);
    if (target !== path) {
      path = target; id++; pending = true;
      const event = { path, webviewId: id, routeEventId: "route-" + (++sequence), openType: "switchTab" };
      emit("route", event);
      if (staleDone) emit("done", { ...event, routeEventId: "old-route" });
      if (!neverDone) setTimeout(() => { pending = false; events.push("done"); emit("done", event); }, 20);
    }
    if (changeAccount) current = { accessToken: "other-user" };
    input.success?.({ errMsg: "switchTab:ok" }); input.complete?.({ errMsg: "switchTab:ok" });
  }
  wx.switchTab = dispatch; wx.navigateTo = dispatch;
  const context = createContext({ wx, require: () => session, getCurrentPages: () => [{ route: path, __wxWebviewId__: id }], Date, Object, Error });
  context.global = context;
  const mini = {
    evaluate: async (action, ...args) => { context.args = args; return runInContext(`(${action.toString()})(...args)`, context); },
    currentPage: async () => ({ path, id, $: async () => dom ? {} : null }),
    send: async method => { assert.equal(method, "App.getCurrentPage"); return { path, pageId: wrongRawView ? id + 100 : id }; },
    switchTab() { throw Error("must not await the SDK callback wrapper"); },
  };
  return { mini, wx, events, session, listeners, context, get pending() { return pending; } };
}

test("logical path, DOM and success callback cannot pass before actual route-done", async () => {
  const remote = routeTransport();
  const page = await navigate(remote.mini, "switchTab", "/pages/capture/index", { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(page.path, "pages/capture/index");
  assert.equal(remote.pending, false);
  assert.deepEqual(remote.events, ["navigate", "done"]);
});

test("missing or stale same-path route-done events cannot complete navigation", async () => {
  for (const staleDone of [false, true]) {
    const remote = routeTransport({ neverDone: true, staleDone });
    await assert.rejects(navigate(remote.mini, "switchTab", "/pages/capture/index", { timeoutMs: 60, intervalMs: 1 }), /route.*timed out/);
    assert.equal(remote.pending, true);
  }
});

test("two requested transitions serialize through actual route-done", async () => {
  const remote = routeTransport();
  const pages = await Promise.all([
    navigate(remote.mini, "switchTab", "/pages/capture/index", { timeoutMs: 1000, intervalMs: 1 }),
    navigate(remote.mini, "switchTab", "/pages/library/index", { timeoutMs: 1000, intervalMs: 1 }),
  ]);
  assert.deepEqual(pages.map(page => page.path), ["pages/capture/index", "pages/library/index"]);
  assert.deepEqual(remote.events, ["navigate", "done", "navigate", "done"]);
});

test("a real gesture route must finish its matching native transition", async () => {
  const remote = routeTransport({ initialPath: "pages/wardrobe/index" }); let taps = 0;
  const page = await driver.tapAndWaitForRoute(remote.mini, "album return", { tap: async () => { taps++; remote.wx.switchTab({ url: "/pages/library/index" }); } }, "/pages/library/index", { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(page.path, "pages/library/index"); assert.equal(taps, 1); assert.equal(remote.pending, false);
});

test("route observer requires supported native events and removes only owned listeners", async () => {
  const unsupported = routeTransport({ supported: false });
  await assert.rejects(navigate(unsupported.mini, "switchTab", "/pages/capture/index"), /NATIVE_ROUTE_EVENTS_UNAVAILABLE/);
  assert.deepEqual(unsupported.events, []);
  const remote = routeTransport();
  await navigate(remote.mini, "switchTab", "/pages/capture/index", { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(remote.listeners.route.size, 1); assert.equal(remote.listeners.done.size, 1);
  await driver.disposeRouteObserver(remote.mini);
  assert.equal(remote.listeners.route.size, 0); assert.equal(remote.listeners.done.size, 0);
});

test("matching route and DOM cannot pass for the wrong native webview", async () => {
  const remote = routeTransport({ wrongRawView: true });
  await assert.rejects(navigate(remote.mini, "switchTab", "/pages/library/index", { timeoutMs: 80, intervalMs: 1 }), /route.*timed out/);
  assert.equal(remote.pending, false);
  await driver.disposeRouteObserver(remote.mini);
});

test("a no-op return gesture cannot reuse a previous same-path completion", async () => {
  const remote = routeTransport(); let taps = 0;
  await navigate(remote.mini, "switchTab", "/pages/library/index", { timeoutMs: 1000, intervalMs: 1 });
  await assert.rejects(driver.tapAndWaitForRoute(remote.mini, "album return", { tap: async () => { taps++; } }, "/pages/library/index", { timeoutMs: 60, intervalMs: 1 }), /route.*timed out/);
  assert.equal(taps, 1);
  assert.deepEqual(remote.events, ["navigate", "done"]);
  await driver.disposeRouteObserver(remote.mini);
});

function contextTransport({ rawPath = "pages/home/index", sdkPath = rawPath, logicalPath = rawPath, rawId = 1, sdkId = rawId, logicalId = rawId, root = true, hang = false } = {}) {
  return {
    send: async () => ({ path: rawPath, pageId: rawId }),
    currentPage: async () => ({ path: sdkPath, id: sdkId, $: async selector => {
      assert.equal(selector, ".page");
      return hang ? new Promise(() => {}) : root ? {} : null;
    } }),
    evaluate: async () => ({ path: logicalPath, pageId: logicalId }),
  };
}

test("native context admission requires matching raw, SDK and logical pages plus rendered root", async () => {
  assert.deepEqual(await driver.verifyNativeContext(contextTransport()), { status: "READY", path: "pages/home/index", pageId: 1 });
});

test("divergent native context paths and IDs cannot admit fixture setup", async () => {
  for (const input of [{ sdkPath: "pages/wardrobe/index" }, { logicalPath: "pages/library/index" }, { sdkId: 15 }, { logicalId: 15 }]) {
    await assert.rejects(driver.verifyNativeContext(contextTransport(input)), error => error instanceof driver.NativeContextNotReadyError && error.report.status === "UNAVAILABLE" && /MISMATCH/.test(error.report.reason));
  }
});

test("a missing rendered root cannot pass despite matching page state", async () => {
  await assert.rejects(driver.verifyNativeContext(contextTransport({ root: false })), error => error instanceof driver.NativeContextNotReadyError && error.report.phase === "rendered_root" && error.report.reason === "NATIVE_CONTEXT_ROOT_MISSING");
});

test("a hung context DOM RPC is bounded and remains unavailable", async () => {
  await assert.rejects(driver.verifyNativeContext(contextTransport({ hang: true }), { timeoutMs: 20 }), error => error instanceof driver.NativeContextNotReadyError && error.report.phase === "rendered_root" && /timed out/.test(error.report.reason));
});
