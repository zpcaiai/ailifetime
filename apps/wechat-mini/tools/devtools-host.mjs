import { execFileSync } from "node:child_process";

export function nativeHostSession({ platform = process.platform, execute = execFileSync } = {}) {
  if (platform !== "darwin") return { platform, status: "NOT_APPLICABLE" };
  try {
    const options = { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
    const plist = execute("/usr/sbin/ioreg", ["-a", "-n", "Root", "-d1"], options);
    const read = (key, format) => JSON.parse(execute("/usr/bin/plutil", ["-extract", key, format, "-o", "-", "-"], { ...options, input: plist }));
    const locked = read("IOConsoleLocked", "raw"), users = read("IOConsoleUsers", "json");
    if (typeof locked !== "boolean" || !Array.isArray(users) || users.some(user => !user || typeof user !== "object" || Array.isArray(user))) throw new Error("INVALID_HOST_SESSION_STATE");
    const consoleUsers = users.filter(user => user.kCGSSessionOnConsoleKey === true);
    const screenLocked = locked || consoleUsers.some(user => user.CGSSessionScreenIsLocked === true);
    return { platform, status: screenLocked ? "LOCKED" : consoleUsers.length ? "READY" : "NO_INTERACTIVE_SESSION", screenLocked, interactiveConsole: consoleUsers.length > 0 };
  } catch {
    // Do not include the raw registry, usernames or subprocess output in logs.
    return { platform, status: "UNAVAILABLE" };
  }
}

export class NativeHostNotReadyError extends Error {
  constructor(report) {
    super(`HOST_GUI_${report.status}: native UI verification requires an unlocked interactive console; no native scenario was started`);
    this.name = "NativeHostNotReadyError";
    this.report = report;
  }
}

export function requireNativeHostSession(options) {
  const report = nativeHostSession(options);
  if (report.status !== "READY" && report.status !== "NOT_APPLICABLE") throw new NativeHostNotReadyError(report);
  return report;
}
