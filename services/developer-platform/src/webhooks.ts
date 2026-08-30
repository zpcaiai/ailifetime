import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { clone, DeveloperPlatformError, digest, redact, required, utc, unique } from "./common.js";

export interface WebhookEndpointInput {
  readonly id: string;
  readonly partnerId: string;
  readonly applicationId: string;
  readonly environment: "sandbox" | "staging" | "production";
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly payloadVersion: number;
  readonly ratePerMinute: number;
  readonly concurrencyLimit: number;
  readonly allowedFields: readonly string[];
}

export interface WebhookEndpoint extends WebhookEndpointInput {
  readonly verified: boolean;
  readonly paused: boolean;
  readonly createdAt: string;
  readonly currentKeyId: string;
  readonly previousKeyId?: string;
  readonly dualSignUntil?: string;
  readonly terminatedAt?: string;
}

export interface WebhookSecret {
  readonly endpointId: string;
  readonly keyId: string;
  readonly secret: string;
  readonly challenge: string;
  readonly shownOnce: true;
}

export interface WebhookEvent {
  readonly eventId: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly purpose: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
}

export interface WebhookResponse { readonly status: number; readonly body: Uint8Array; readonly latencyMs: number; }
export interface WebhookSender { send(request: WebhookRequest): Promise<WebhookResponse>; }
export interface WebhookDeliveryPolicy {
  readonly environment?: "test" | "sandbox" | "staging" | "production";
  /** Resolve on every delivery to prevent DNS rebinding into private space. */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

export interface WebhookAttempt {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly state: "SUCCEEDED" | "RETRYABLE" | "DEAD_LETTERED";
  readonly status: number;
  readonly latencyMs: number;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseBody: unknown;
  readonly nextDelayMs?: number;
}

interface EncryptedSecret { readonly nonce: Buffer; readonly ciphertext: Buffer; readonly tag: Buffer; }
interface StoredEndpoint { value: WebhookEndpoint; readonly secrets: Map<string, EncryptedSecret>; readonly challengeDigest: string; active: number; readonly sentAt: number[]; }

export class WebhookDeliveryService {
  readonly #endpoints = new Map<string, StoredEndpoint>();
  readonly #attempts = new Map<string, WebhookAttempt[]>();
  readonly #events = new Map<string, WebhookEvent>();
  readonly #policy: { readonly environment: NonNullable<WebhookDeliveryPolicy["environment"]>; readonly resolveHost?: WebhookDeliveryPolicy["resolveHost"] };

  constructor(readonly encryptionKey: Buffer, readonly sender: WebhookSender, readonly now: () => Date = () => new Date(), policy: WebhookDeliveryPolicy = {}) {
    if (encryptionKey.length !== 32) throw new DeveloperPlatformError("VALIDATION_FAILED", "webhook envelope key must be exactly 32 bytes");
    this.#policy = { environment: policy.environment ?? "test", resolveHost: policy.resolveHost };
    if (this.#policy.environment === "production" && this.#policy.resolveHost === undefined) throw new DeveloperPlatformError("DEPENDENCY_FAILED", "production webhook delivery requires a DNS resolver bound to the egress policy");
  }

  register(input: WebhookEndpointInput): WebhookSecret {
    validateEndpoint(input);
    if (this.#endpoints.has(input.id)) throw new DeveloperPlatformError("CONFLICT", "webhook endpoint already exists");
    const keyId = randomBytes(8).toString("hex"); const secret = randomBytes(32).toString("base64url"); const challenge = randomBytes(24).toString("base64url");
    const value: WebhookEndpoint = Object.freeze({ ...clone(input), verified: false, paused: true, createdAt: this.now().toISOString(), currentKeyId: keyId });
    this.#endpoints.set(input.id, { value, secrets: new Map([[keyId, encrypt(secret, this.encryptionKey)]]), challengeDigest: digest(challenge), active: 0, sentAt: [] });
    return Object.freeze({ endpointId: input.id, keyId, secret, challenge, shownOnce: true });
  }

  verifyChallenge(endpointId: string, challengeResponse: string): WebhookEndpoint {
    const stored = this.#endpoint(endpointId);
    if (digest(challengeResponse) !== stored.challengeDigest) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "webhook domain challenge response is invalid");
    stored.value = Object.freeze({ ...stored.value, verified: true, paused: false });
    return stored.value;
  }

  rotateSecret(endpointId: string, dualSignUntil: string): WebhookSecret {
    const stored = this.#endpoint(endpointId); utc(dualSignUntil, "dualSignUntil");
    if (Date.parse(dualSignUntil) <= this.now().getTime() || Date.parse(dualSignUntil) > this.now().getTime() + 7 * 86_400_000) throw new DeveloperPlatformError("VALIDATION_FAILED", "dual-sign window must be positive and at most seven days");
    const keyId = randomBytes(8).toString("hex"); const secret = randomBytes(32).toString("base64url");
    stored.secrets.set(keyId, encrypt(secret, this.encryptionKey));
    stored.value = Object.freeze({ ...stored.value, previousKeyId: stored.value.currentKeyId, currentKeyId: keyId, dualSignUntil });
    return Object.freeze({ endpointId, keyId, secret, challenge: "already-verified", shownOnce: true });
  }

  pause(endpointId: string, paused: boolean): WebhookEndpoint {
    const stored = this.#endpoint(endpointId);
    stored.value = Object.freeze({ ...stored.value, paused });
    return stored.value;
  }

  terminate(endpointId: string): WebhookEndpoint {
    const stored = this.#endpoint(endpointId);
    stored.value = Object.freeze({ ...stored.value, paused: true, terminatedAt: this.now().toISOString() });
    stored.secrets.clear();
    return stored.value;
  }

  async deliver(endpointId: string, event: WebhookEvent, options: { readonly replayBy?: string } = {}): Promise<readonly WebhookAttempt[]> {
    const stored = this.#endpoint(endpointId);
    if (!stored.value.verified || stored.value.paused || stored.value.terminatedAt !== undefined) throw new DeveloperPlatformError("POLICY_BLOCKED", "webhook endpoint is not eligible for delivery");
    await this.#assertPublicDestination(stored.value.url);
    validateEvent(event, stored.value);
    const priorEvent = this.#events.get(event.eventId);
    if (priorEvent !== undefined && digest(priorEvent) !== digest(event)) throw new DeveloperPlatformError("CONFLICT", "event id was reused with a changed business event");
    if (priorEvent !== undefined && options.replayBy === undefined) return Object.freeze([]);
    if (options.replayBy !== undefined) required(options.replayBy, "replay actor");
    if (stored.active >= stored.value.concurrencyLimit) throw new DeveloperPlatformError("RATE_LIMITED", "webhook endpoint concurrency limit exceeded");
    const nowMs = this.now().getTime();
    stored.sentAt.splice(0, stored.sentAt.length, ...stored.sentAt.filter((value) => value > nowMs - 60_000));
    if (stored.sentAt.length >= stored.value.ratePerMinute) throw new DeveloperPlatformError("RATE_LIMITED", "webhook endpoint rate limit exceeded");
    this.#events.set(event.eventId, Object.freeze(clone(event)));
    stored.sentAt.push(nowMs); stored.active += 1;
    const deliveryId = `${options.replayBy === undefined ? "delivery" : "replay"}-${event.eventId}-${this.#attempts.size + 1}`;
    const attempts: WebhookAttempt[] = [];
    try {
      const minimized = Object.fromEntries(Object.entries(event.payload).filter(([key]) => stored.value.allowedFields.includes(key)));
      const body = Buffer.from(JSON.stringify({ id: event.eventId, type: event.type, version: event.version, occurredAt: event.occurredAt, data: minimized }), "utf8");
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const timestamp = this.now().toISOString(); const nonce = randomBytes(16).toString("hex");
        const headers = this.#signedHeaders(stored, event, body, timestamp, nonce);
        const response = await this.sender.send({ url: stored.value.url, headers, body, timeoutMs: 10_000 });
        if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 || response.latencyMs < 0) throw new DeveloperPlatformError("DEPENDENCY_FAILED", "webhook sender returned an invalid response");
        const success = response.status >= 200 && response.status < 300;
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        const state: WebhookAttempt["state"] = success ? "SUCCEEDED" : retryable && attempt < 5 ? "RETRYABLE" : "DEAD_LETTERED";
        const nextDelayMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
        const record: WebhookAttempt = Object.freeze({ deliveryId, endpointId, eventId: event.eventId, attempt, state, status: response.status, latencyMs: response.latencyMs, requestHeaders: Object.freeze({ ...headers, "x-ltm-signature": "[REDACTED]", "x-ltm-signature-previous": headers["x-ltm-signature-previous"] === undefined ? "" : "[REDACTED]" }), responseBody: redact(Buffer.from(response.body).toString("utf8")), ...(state === "RETRYABLE" ? { nextDelayMs } : {}) });
        attempts.push(record);
        if (state !== "RETRYABLE") break;
      }
      if (attempts.at(-1)?.state === "DEAD_LETTERED") stored.value = Object.freeze({ ...stored.value, paused: true });
      this.#attempts.set(deliveryId, attempts);
      return Object.freeze(attempts.map(clone));
    } finally { stored.active -= 1; }
  }

  attempts(endpointId: string): readonly WebhookAttempt[] {
    this.#endpoint(endpointId);
    return Object.freeze([...this.#attempts.values()].flat().filter((attempt) => attempt.endpointId === endpointId).map(clone));
  }

  endpoint(endpointId: string): WebhookEndpoint { return Object.freeze(clone(this.#endpoint(endpointId).value)); }

  #signedHeaders(stored: StoredEndpoint, event: WebhookEvent, body: Buffer, timestamp: string, nonce: string): Readonly<Record<string, string>> {
    const signingInput = Buffer.from(`ltm-webhook-v1\n${event.eventId}\n${timestamp}\n${nonce}\n${digest(body.toString("utf8"))}\n`, "utf8");
    const current = decrypt(stored.secrets.get(stored.value.currentKeyId) as EncryptedSecret, this.encryptionKey);
    const headers: Record<string, string> = { "content-type": "application/json", "x-ltm-event-id": event.eventId, "x-ltm-event-version": String(event.version), "x-ltm-webhook-timestamp": timestamp, "x-ltm-webhook-nonce": nonce, "x-ltm-key-id": stored.value.currentKeyId, "x-ltm-signature": createHmac("sha256", current).update(signingInput).digest("base64") };
    if (stored.value.previousKeyId !== undefined && stored.value.dualSignUntil !== undefined && Date.parse(stored.value.dualSignUntil) > this.now().getTime()) {
      const previous = decrypt(stored.secrets.get(stored.value.previousKeyId) as EncryptedSecret, this.encryptionKey);
      headers["x-ltm-previous-key-id"] = stored.value.previousKeyId;
      headers["x-ltm-signature-previous"] = createHmac("sha256", previous).update(signingInput).digest("base64");
    }
    return Object.freeze(headers);
  }

  #endpoint(endpointId: string): StoredEndpoint {
    const endpoint = this.#endpoints.get(endpointId);
    if (endpoint === undefined) throw new DeveloperPlatformError("NOT_FOUND", "webhook endpoint does not exist");
    return endpoint;
  }

  async #assertPublicDestination(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (isPrivateAddress(hostname)) throw new DeveloperPlatformError("POLICY_BLOCKED", "webhook destination resolves to a private or local network");
    if (this.#policy.resolveHost === undefined) return;
    let addresses: readonly string[];
    try { addresses = await this.#policy.resolveHost(hostname); } catch { throw new DeveloperPlatformError("DEPENDENCY_FAILED", "webhook destination DNS resolution failed"); }
    if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address))) throw new DeveloperPlatformError("POLICY_BLOCKED", "webhook destination resolves to a private or local network");
  }
}

function validateEndpoint(input: WebhookEndpointInput): void {
  required(input.id, "endpoint id"); required(input.partnerId, "partnerId"); required(input.applicationId, "applicationId"); unique(input.eventTypes, "webhook event types"); unique(input.allowedFields, "webhook allowed fields");
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.pathname === "" || url.hash !== "") throw new DeveloperPlatformError("POLICY_BLOCKED", "webhook URL must be a credential-free HTTPS origin path");
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host) || host.endsWith(".internal")) throw new DeveloperPlatformError("POLICY_BLOCKED", "webhook URL cannot target a private or local network");
  if (!Number.isSafeInteger(input.payloadVersion) || input.payloadVersion < 1 || !Number.isSafeInteger(input.ratePerMinute) || input.ratePerMinute < 1 || !Number.isSafeInteger(input.concurrencyLimit) || input.concurrencyLimit < 1 || input.concurrencyLimit > 100) throw new DeveloperPlatformError("VALIDATION_FAILED", "webhook version or limits are invalid");
}

function isPrivateAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(address) === 4) {
    const [first = -1, second = -1] = address.split(".").map(Number);
    return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || first === 0;
  }
  if (isIP(address) === 6) return address === "::1" || address === "::" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb") || address.startsWith("::ffff:10.") || address.startsWith("::ffff:192.168.") || address.startsWith("::ffff:172.");
  return false;
}

function validateEvent(event: WebhookEvent, endpoint: WebhookEndpoint): void {
  required(event.eventId, "event id"); required(event.tenantId, "event tenant"); required(event.purpose, "event purpose"); utc(event.occurredAt, "event occurredAt");
  if (!endpoint.eventTypes.includes(event.type) || event.version !== endpoint.payloadVersion) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "endpoint is not subscribed to this event type/version");
  if (Object.keys(event.payload).some((key) => /face|media|child|conversation|credential/i.test(key))) throw new DeveloperPlatformError("POLICY_BLOCKED", "webhook payload contains a prohibited sensitive category");
}

function encrypt(secret: string, key: Buffer): EncryptedSecret {
  const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce); const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Object.freeze({ nonce, ciphertext, tag: cipher.getAuthTag() });
}
function decrypt(value: EncryptedSecret, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, value.nonce); decipher.setAuthTag(value.tag); return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
}
