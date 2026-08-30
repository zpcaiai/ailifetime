import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { authorization, canonical, fail, id, iso, object, sha256, text } from "./contracts.mjs";

const MAX_BYTES = 32 * 1024 * 1024;

export function emptyNotificationState() {
  return {
    schemaVersion: "ltm.notification-state.v1",
    revision: 0,
    records: { preferences: {}, contacts: {}, messages: {}, callbacks: {}, providerConfigs: {}, templates: {}, journeys: {}, tasks: {}, dlq: {}, suppressions: {}, deliverability: {}, frequency: {}, experiments: {}, analytics: [], operations: {} },
    idempotency: {},
    audit: [],
  };
}

function validateState(state) {
  object(state, "state");
  if (state.schemaVersion !== "ltm.notification-state.v1" || !Number.isSafeInteger(state.revision) || state.revision < 0) fail("STATE_INVALID", "state header is invalid");
  object(state.records, "state.records"); object(state.idempotency, "state.idempotency");
  if (!Array.isArray(state.audit) || state.audit.length !== state.revision) fail("AUDIT_INVALID", "audit length does not match revision");
  let previousSha256 = "0".repeat(64);
  for (const [index, event] of state.audit.entries()) {
    if (event.sequence !== index + 1 || event.previousSha256 !== previousSha256) fail("AUDIT_INVALID", "audit chain sequence is invalid");
    const { eventSha256, ...unsigned } = event;
    if (sha256(unsigned) !== eventSha256) fail("AUDIT_INVALID", "audit digest is invalid");
    previousSha256 = eventSha256;
  }
  canonical(state);
  return state;
}

function applyTransaction(state, operation, mutation) {
  const auth = authorization(operation.authorization, { tenantId: operation.tenantId, purpose: operation.purpose });
  const action = id(operation.action, "action");
  const subject = text(operation.subject, "subject", 256);
  const idempotencyKey = id(operation.idempotencyKey, "idempotencyKey");
  const at = iso(operation.at, "at");
  const requestSha256 = sha256(operation.input);
  const prior = state.idempotency[idempotencyKey];
  if (prior !== undefined) {
    if (prior.action !== action || prior.subject !== subject || prior.requestSha256 !== requestSha256 || prior.tenantId !== operation.tenantId) fail("IDEMPOTENCY_CONFLICT", "idempotency key was reused for another request");
    return structuredClone(prior.result);
  }
  const result = mutation(state.records, structuredClone(state));
  if (result === undefined) fail("MUTATION_INVALID", "mutation must return a result");
  state.revision += 1;
  const event = { sequence: state.revision, at, actorId: auth.actorId, tenantId: auth.tenantId, purpose: auth.purpose, action, subject, idempotencyKey, requestSha256, resultSha256: sha256(result), previousSha256: state.audit.at(-1)?.eventSha256 ?? "0".repeat(64) };
  const eventSha256 = sha256(event);
  state.audit.push({ ...event, eventSha256 });
  state.idempotency[idempotencyKey] = { action, subject, requestSha256, tenantId: operation.tenantId, result: structuredClone(result) };
  return result;
}

export class NotificationStateStore {
  read() { fail("STATE_ADAPTER_REQUIRED", "read must be implemented by a durable state adapter"); }
  transact(_operation, _mutation) { fail("STATE_ADAPTER_REQUIRED", "transact must be implemented by a durable state adapter"); }
}

export class MemoryNotificationStateStore extends NotificationStateStore {
  constructor(seed = emptyNotificationState()) { super(); this.state = validateState(structuredClone(seed)); }
  read() { return structuredClone(validateState(this.state)); }
  transact(operation, mutation) { const next = this.read(); const result = applyTransaction(next, operation, mutation); this.state = validateState(next); return structuredClone(result); }
}

export class FileNotificationStateStore extends NotificationStateStore {
  constructor(pathValue) {
    super();
    if (typeof pathValue !== "string" || !isAbsolute(pathValue)) fail("STATE_PATH_INVALID", "state path must be absolute");
    this.path = resolve(pathValue); this.lockPath = `${this.path}.lock`;
  }
  initialize() { mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); if (!existsSync(this.path)) this.#write(emptyNotificationState(), "initial"); return this.read(); }
  read() {
    if (!existsSync(this.path)) return emptyNotificationState();
    const metadata = lstatSync(this.path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_BYTES) fail("STATE_FILE_INVALID", "state must be a bounded regular file");
    let descriptor;
    try {
      descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stable = fstatSync(descriptor);
      if (stable.size !== metadata.size || !stable.isFile()) fail("STATE_FILE_CHANGED", "state changed while being read");
      return validateState(JSON.parse(readFileSync(descriptor, "utf8")));
    } catch (error) { if (error?.name === "NotificationError") throw error; fail("STATE_READ_FAILED", "state could not be read"); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  transact(operation, mutation) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); } catch { fail("STATE_BUSY", "another transaction is active"); }
    try { const next = this.read(); const result = applyTransaction(next, operation, mutation); this.#write(next, `${next.revision}`); return structuredClone(result); }
    finally { if (lock !== undefined) closeSync(lock); rmSync(this.lockPath, { force: true }); }
  }
  #write(state, suffix) {
    validateState(state);
    const bytes = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail("STATE_LIMIT", "state exceeds limit");
    const temporary = `${this.path}.${suffix}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
  }
}
