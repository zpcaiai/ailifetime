import assert from "node:assert/strict";
import test from "node:test";
import { nativeHostSession, NativeHostNotReadyError, requireNativeHostSession } from "./devtools-host.mjs";

function platformState(locked, users) {
  const calls = [];
  return { platform: "darwin", calls, execute(command, args, options) {
    calls.push({ command, args }); assert.equal(options.timeout, 5000);
    if (command === "/usr/sbin/ioreg") return "private plist input";
    assert.equal(command, "/usr/bin/plutil"); assert.equal(options.input, "private plist input");
    return JSON.stringify(args[1] === "IOConsoleLocked" ? locked : users);
  } };
}
test("locked console is rejected before native work, without exposing user identity", () => {
  const input = platformState(true, [{ kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: true, kCGSSessionUserNameKey: "private-user" }]);
  assert.throws(() => requireNativeHostSession(input), error => error instanceof NativeHostNotReadyError && error.report.status === "LOCKED");
  assert.doesNotMatch(JSON.stringify(nativeHostSession(input)), /private-user|private plist/);
});
test("per-session lock cannot be overridden by a false root lock flag", () => {
  assert.equal(nativeHostSession(platformState(false, [{ kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: true }])).status, "LOCKED");
});
test("unlocked interactive console is admitted when the lock key is absent", () => {
  const report = requireNativeHostSession(platformState(false, [{ kCGSSessionOnConsoleKey: true }]));
  assert.equal(report.status, "READY"); assert.equal(report.screenLocked, false); assert.equal(report.interactiveConsole, true);
});
test("unlocked without a console session is not native UI readiness", () => {
  assert.throws(() => requireNativeHostSession(platformState(false, [{ kCGSSessionOnConsoleKey: false }])), /HOST_GUI_NO_INTERACTIVE_SESSION/);
});
test("malformed lock and session projections fail closed", () => {
  for (const input of [platformState("false", []), platformState(false, null), platformState(false, [null])]) {
    assert.throws(() => requireNativeHostSession(input), /HOST_GUI_UNAVAILABLE/);
  }
});
test("unavailable OS command and invalid JSON cannot silently pass", () => {
  for (const execute of [() => { throw Error("private command failure"); }, () => "invalid JSON"]) {
    const report = nativeHostSession({ platform: "darwin", execute });
    assert.equal(report.status, "UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(report), /private command/);
  }
});
test("non-macOS hosts do not claim a tested macOS GUI session", () => {
  assert.deepEqual(nativeHostSession({ platform: "win32", execute() { throw Error("must not run macOS commands"); } }), { platform: "win32", status: "NOT_APPLICABLE" });
});
