import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalJson, identifier, plainObject, requiredString, sha256, timestamp, fail } from "./contracts.mjs";

const MAX_STATE_BYTES = 32 * 1024 * 1024;

function emptyState() {
  return {
    schemaVersion: "ltm.public-web-state.v1",
    revision: 0,
    records: {
      pages: {},
      content: {},
      consents: {},
      attribution: {},
      campaigns: {},
      shares: {},
      trust: {},
      incidents: {},
      salesAssets: {},
    },
    idempotency: {},
    audit: [],
  };
}

export class VersionedMarketingStore {
  constructor(pathValue, { mode = "local-dev", lockLeaseMs = 30_000 } = {}) {
    if (typeof pathValue !== "string" || !isAbsolute(pathValue)) fail("STORE_PATH_INVALID", "state path must be absolute");
    if (mode !== "local-dev" && mode !== "test") fail("STORE_BACKEND_UNSAFE", "the file marketing store is restricted to local development and tests");
    this.path = resolve(pathValue);
    this.lockPath = `${this.path}.lock`;
    this.lockLeaseMs = Number.isSafeInteger(lockLeaseMs) && lockLeaseMs >= 1_000 && lockLeaseMs <= 300_000 ? lockLeaseMs : fail("STORE_LOCK_INVALID", "lock lease must be between one and 300 seconds");
  }

  initialize() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) this.#write(emptyState(), "initialize");
    return this.read();
  }

  read() {
    if (!existsSync(this.path)) return emptyState();
    const metadata = lstatSync(this.path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_STATE_BYTES) {
      fail("STORE_FILE_INVALID", "state must be a bounded regular non-symlink file");
    }
    let descriptor;
    try {
      descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stable = fstatSync(descriptor);
      if (!stable.isFile() || stable.size !== metadata.size) fail("STORE_FILE_CHANGED", "state changed while being read");
      const state = JSON.parse(readFileSync(descriptor, "utf8"));
      validateState(state);
      return state;
    } catch (error) {
      if (error?.code !== undefined && error.name === "PublicWebError") throw error;
      fail("STORE_READ_FAILED", "state could not be read as valid JSON");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  transact({ actorId, action, subject, idempotencyKey, input, at }, mutation) {
    const actor = identifier(actorId, "actorId");
    const normalizedAction = identifier(action, "action");
    const normalizedSubject = requiredString(subject, "subject", 256);
    const key = identifier(idempotencyKey, "idempotencyKey");
    const occurredAt = timestamp(at ?? new Date().toISOString(), "at");
    const requestSha256 = sha256(input);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock; const lockToken = randomUUID();
    try {
      lock = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch {
      this.#recoverStaleLock(occurredAt);
      try { lock = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
      catch { fail("STORE_BUSY", "another public-web state transaction is active"); }
    }
    try {
      writeFileSync(lock, JSON.stringify({ schemaVersion: "ltm.public-web-lock.v1", ownerPid: process.pid, token: lockToken, acquiredAt: occurredAt }), { encoding: "utf8" });
      fsyncSync(lock);
      const state = this.read();
      const prior = state.idempotency[key];
      if (prior !== undefined) {
        if (prior.requestSha256 !== requestSha256 || prior.action !== normalizedAction || prior.subject !== normalizedSubject) {
          fail("IDEMPOTENCY_CONFLICT", "idempotency key was reused for a different request");
        }
        return structuredClone(prior.result);
      }
      const result = mutation(state.records, structuredClone(state));
      if (result === undefined) fail("STORE_MUTATION_INVALID", "state mutation must return a result");
      state.revision += 1;
      const previousSha256 = state.audit.at(-1)?.eventSha256 ?? "0".repeat(64);
      const event = {
        sequence: state.revision,
        at: occurredAt,
        actorId: actor,
        action: normalizedAction,
        subject: normalizedSubject,
        idempotencyKey: key,
        requestSha256,
        resultSha256: sha256(result),
        previousSha256,
      };
      const eventSha256 = sha256(event);
      state.audit.push({ ...event, eventSha256 });
      state.idempotency[key] = {
        action: normalizedAction,
        subject: normalizedSubject,
        requestSha256,
        result: structuredClone(result),
        revision: state.revision,
      };
      this.#write(state, `${state.revision}`);
      return result;
    } finally {
      if (lock !== undefined) closeSync(lock);
      this.#releaseOwnedLock(lockToken);
    }
  }

  #write(state, suffix) {
    validateState(state);
    const temporary = `${this.path}.${suffix}.${process.pid}.tmp`;
    const bytes = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) fail("STORE_LIMIT_EXCEEDED", "state exceeds its size limit");
    let descriptor; let directory;
    try {
      descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, bytes, { encoding: "utf8" }); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, this.path);
      directory = openSync(dirname(this.path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); fsyncSync(directory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (directory !== undefined) closeSync(directory);
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }

  #recoverStaleLock(nowValue) {
    if (!existsSync(this.lockPath)) return;
    const metadata = lstatSync(this.lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 4_096) fail("STORE_BUSY", "public-web lock is not safely recoverable");
    let lock;
    try { lock = JSON.parse(readFileSync(this.lockPath, "utf8")); } catch { fail("STORE_BUSY", "public-web lock metadata is invalid"); }
    if (lock.schemaVersion !== "ltm.public-web-lock.v1" || !Number.isSafeInteger(lock.ownerPid) || typeof lock.token !== "string") fail("STORE_BUSY", "public-web lock metadata is invalid");
    const acquiredAt = new Date(timestamp(lock.acquiredAt, "lock acquiredAt")).getTime();
    if (new Date(nowValue).getTime() - acquiredAt <= this.lockLeaseMs || processAlive(lock.ownerPid)) fail("STORE_BUSY", "another public-web state transaction is active");
    rmSync(this.lockPath, { force: false });
  }

  #releaseOwnedLock(token) {
    if (!existsSync(this.lockPath)) return;
    try {
      const metadata = lstatSync(this.lockPath); if (!metadata.isFile() || metadata.isSymbolicLink()) return;
      const lock = JSON.parse(readFileSync(this.lockPath, "utf8"));
      if (lock.token === token && lock.ownerPid === process.pid) rmSync(this.lockPath, { force: false });
    } catch { /* Never remove a lock whose ownership cannot be proven. */ }
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function validateState(value) {
  const state = plainObject(value, "public-web state");
  if (state.schemaVersion !== "ltm.public-web-state.v1" || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    fail("STORE_SCHEMA_INVALID", "state schema or revision is invalid");
  }
  plainObject(state.records, "state.records");
  plainObject(state.idempotency, "state.idempotency");
  if (!Array.isArray(state.audit) || state.audit.length !== state.revision) fail("STORE_AUDIT_INVALID", "audit length must equal revision");
  let previous = "0".repeat(64);
  for (const [index, item] of state.audit.entries()) {
    if (item.sequence !== index + 1 || item.previousSha256 !== previous) fail("STORE_AUDIT_INVALID", "audit chain sequence is invalid");
    const { eventSha256, ...unsigned } = item;
    if (sha256(unsigned) !== eventSha256) fail("STORE_AUDIT_INVALID", "audit chain digest is invalid");
    previous = eventSha256;
  }
  // Canonicalization also rejects undefined and non-JSON values before writes.
  canonicalJson(state);
}
