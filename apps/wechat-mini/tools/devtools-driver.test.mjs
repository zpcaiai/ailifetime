import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
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
  let dispatched = false, reads = 0;
  const page = { path: "pages/capture/index", $: async selector => { assert.equal(selector, ".page"); return {}; } };
  const mini = {
    evaluate: async (action, kind, url) => { assert.equal(typeof action, "function"); assert.equal(kind, "switchTab"); assert.equal(url, "/pages/capture/index"); dispatched = true; },
    currentPage: async () => { assert.ok(dispatched); return ++reads < 3 ? { path: "pages/home/index" } : page; },
    switchTab() { throw Error("SDK callback wrapper must not gate observable navigation"); },
  };
  assert.equal(await navigate(mini, "switchTab", "/pages/capture/index", { timeoutMs: 100, intervalMs: 1 }), page);
});

test("dispatched navigation and matching logical path cannot pass without a rendered page", async () => {
  const mini = { evaluate: async () => true, currentPage: async () => ({ path: "pages/capture/index", $: async () => null }) };
  await assert.rejects(navigate(mini, "switchTab", "/pages/capture/index", { timeoutMs: 15, intervalMs: 1 }), /route.*timed out/);
  await assert.rejects(navigate(mini, "close", "/pages/capture/index"), /UNSUPPORTED_NATIVE_ROUTE/);
});

test("native tap acknowledgment cannot pass until its event changes observable state", async () => {
  let taps = 0, observations = 0;
  const element = { tap: async () => { taps++; } };
  assert.equal(await tapAndWait("cancel", element, async () => ++observations > 2, { timeoutMs: 100, intervalMs: 1 }), true);
  assert.equal(taps, 1);
  await assert.rejects(tapAndWait("denied", element, async () => false, { timeoutMs: 15, intervalMs: 1 }), /denied.*timed out/);
});

function sessionTransport({ rejectRoute = false, changeAccount = false } = {}) {
  let current = { accessToken: "owned" }, path = "pages/wardrobe/index";
  const events = [], session = { get: () => current, clear: () => { events.push("clear"); current = null; } };
  const mini = {
    evaluate: async (action, ...args) => runInNewContext(`(${action.toString()})(...args)`, {
      args, require: () => session, wx: { switchTab() {
        if (!current) throw Error("AUTH_REDIRECT_RACE");
        if (rejectRoute) throw Error("native route rejected");
        events.push("navigate"); path = "pages/home/index";
        if (changeAccount) current = { accessToken: "other-user" };
      } },
    }),
    currentPage: async () => ({ path, $: async () => ({}) }),
  };
  return { mini, events, session };
}

test("cleanup navigates while its exact owned session is valid, then verifies removal", async () => {
  const remote = sessionTransport();
  await cleanupOwnedSession(remote.mini, "owned", { timeoutMs: 100, intervalMs: 1 });
  assert.deepEqual(remote.events, ["navigate", "clear"]);
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
  assert.deepEqual(remote.events, ["navigate"]);
});
