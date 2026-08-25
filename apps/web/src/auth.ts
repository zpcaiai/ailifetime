export type BrowserAuthenticationMode = "unauthenticated" | "injected_bearer";

export interface BrowserAuthenticationSnapshot {
  readonly mode: BrowserAuthenticationMode;
  readonly purpose: string;
  readonly hasInjectedBearer: boolean;
}

export interface BrowserOidcConfiguration {
  readonly schemaVersion: "ltm.browser-oidc-config.v1";
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly audience: string;
}

export interface BrowserOidcRuntime {
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly digestSha256: (value: Uint8Array) => Promise<Uint8Array>;
  readonly replaceUrl: (url: string) => void;
}

interface BrowserOidcTransaction {
  readonly schemaVersion: "ltm.browser-oidc-transaction.v1";
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly configurationSha256: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

const TRANSACTION_KEY = "ltm.browser-oidc.pkce.v1";
const TRANSACTION_TTL_MS = 5 * 60 * 1_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1_024;
const CALLBACK_KEYS = new Set(["code", "state"]);
const ERROR_CALLBACK_KEYS = new Set(["error", "error_description", "state"]);
const CONFIGURATION_KEYS = [
  "schemaVersion", "issuer", "authorizationEndpoint", "tokenEndpoint",
  "clientId", "redirectUri", "scopes", "audience",
] as const;
const TRANSACTION_KEYS = [
  "schemaVersion", "state", "codeVerifier", "redirectUri",
  "configurationSha256", "createdAtMs", "expiresAtMs",
] as const;

/** Public SPA Authorization Code + PKCE S256 client. Tokens are returned once and never persisted. */
export class BrowserOidcClient {
  readonly #runtime: BrowserOidcRuntime;

  constructor(runtime: BrowserOidcRuntime = defaultBrowserOidcRuntime()) {
    this.#runtime = runtime;
  }

  parseConfiguration(value: unknown): BrowserOidcConfiguration {
    const record = closedObject(value, CONFIGURATION_KEYS, "browser OIDC configuration");
    if (record.schemaVersion !== "ltm.browser-oidc-config.v1") throw new Error("unsupported browser OIDC configuration");
    const issuer = strictHttps(record.issuer, "issuer", true);
    const authorizationEndpoint = strictHttps(record.authorizationEndpoint, "authorization endpoint", false);
    const tokenEndpoint = strictHttps(record.tokenEndpoint, "token endpoint", false);
    if (
      issuer.origin !== authorizationEndpoint.origin
      || issuer.origin !== tokenEndpoint.origin
      || !withinIssuerPath(authorizationEndpoint, issuer)
      || !withinIssuerPath(tokenEndpoint, issuer)
    ) {
      throw new Error("browser OIDC endpoints do not share the trusted issuer origin");
    }
    const redirectUri = strictHttps(record.redirectUri, "redirect URI", false);
    if (redirectUri.search !== "" || redirectUri.hash !== "") throw new Error("browser OIDC redirect URI is not exact");
    const clientId = boundedString(record.clientId, "client ID", 1, 256, /^[A-Za-z0-9][A-Za-z0-9._~:-]*$/);
    const audience = boundedString(record.audience, "audience", 1, 512, /^[A-Za-z0-9:/._~-]+$/);
    if (!Array.isArray(record.scopes) || record.scopes.length < 1 || record.scopes.length > 20) {
      throw new Error("browser OIDC scopes are invalid");
    }
    const scopes = record.scopes.map((scope) => boundedString(scope, "scope", 1, 128, /^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/));
    if (new Set(scopes).size !== scopes.length || !scopes.includes("openid") || scopes.includes("offline_access")) {
      throw new Error("browser OIDC scopes are invalid");
    }
    return Object.freeze({
      schemaVersion: "ltm.browser-oidc-config.v1",
      issuer: issuer.toString(),
      authorizationEndpoint: authorizationEndpoint.toString(),
      tokenEndpoint: tokenEndpoint.toString(),
      clientId,
      redirectUri: redirectUri.toString(),
      scopes: Object.freeze(scopes),
      audience,
    });
  }

  isCallback(configurationValue: unknown, currentUrlValue: string): boolean {
    const configuration = this.parseConfiguration(configurationValue);
    const current = new URL(currentUrlValue);
    const redirect = new URL(configuration.redirectUri);
    return current.origin === redirect.origin && current.pathname === redirect.pathname;
  }

  async beginAuthorization(configurationValue: unknown, currentUrlValue: string): Promise<string> {
    const configuration = this.parseConfiguration(configurationValue);
    const current = currentBrowserUrl(currentUrlValue);
    const redirect = new URL(configuration.redirectUri);
    if (current.origin !== redirect.origin) throw new Error("browser origin does not match the registered redirect URI");
    const state = base64Url(this.#runtime.randomBytes(32));
    const codeVerifier = base64Url(this.#runtime.randomBytes(64));
    if (state.length < 43 || codeVerifier.length < 43 || codeVerifier.length > 128) throw new Error("OIDC entropy source failed");
    const codeChallenge = base64Url(await this.#runtime.digestSha256(utf8(codeVerifier)));
    const now = this.#runtime.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("browser clock is invalid");
    const transaction: BrowserOidcTransaction = {
      schemaVersion: "ltm.browser-oidc-transaction.v1",
      state,
      codeVerifier,
      redirectUri: configuration.redirectUri,
      configurationSha256: await configurationDigest(configuration, this.#runtime),
      createdAtMs: now,
      expiresAtMs: now + TRANSACTION_TTL_MS,
    };
    try {
      this.#runtime.storage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
    } catch {
      throw new Error("browser OIDC transaction storage is unavailable");
    }
    const authorization = new URL(configuration.authorizationEndpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", configuration.clientId);
    authorization.searchParams.set("redirect_uri", configuration.redirectUri);
    authorization.searchParams.set("scope", configuration.scopes.join(" "));
    authorization.searchParams.set("audience", configuration.audience);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", codeChallenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    return authorization.toString();
  }

  async completeAuthorization(configurationValue: unknown, currentUrlValue: string): Promise<string | undefined> {
    const configuration = this.parseConfiguration(configurationValue);
    const current = new URL(currentUrlValue);
    const redirect = new URL(configuration.redirectUri);
    if (current.origin !== redirect.origin || current.pathname !== redirect.pathname) return undefined;
    if (current.hash !== "") throw new Error("OIDC callback fragments are forbidden");
    this.#runtime.replaceUrl(configuration.redirectUri);

    let serialized: string | null;
    try {
      serialized = this.#runtime.storage.getItem(TRANSACTION_KEY);
      this.#runtime.storage.removeItem(TRANSACTION_KEY);
    } catch {
      throw new Error("browser OIDC transaction storage is unavailable");
    }
    if (serialized === null) throw new Error("OIDC callback has no live transaction");
    const transaction = parseTransaction(serialized);
    const keys = [...current.searchParams.keys()];
    const errorCallback = current.searchParams.has("error");
    const expectedKeys = errorCallback ? ERROR_CALLBACK_KEYS : CALLBACK_KEYS;
    if (keys.length < 2 || keys.some((key) => !expectedKeys.has(key)) || new Set(keys).size !== keys.length) {
      throw new Error("OIDC callback parameters are invalid");
    }
    const state = callbackValue(current, "state", 43, 256);
    if (state !== transaction.state) throw new Error("OIDC callback state mismatch");
    const now = this.#runtime.now();
    if (
      transaction.redirectUri !== configuration.redirectUri
      || transaction.configurationSha256 !== await configurationDigest(configuration, this.#runtime)
      || now < transaction.createdAtMs
      || now > transaction.expiresAtMs
      || transaction.expiresAtMs - transaction.createdAtMs !== TRANSACTION_TTL_MS
    ) {
      throw new Error("OIDC transaction expired or configuration changed");
    }
    if (errorCallback) {
      const providerError = callbackValue(current, "error", 1, 128);
      if (current.searchParams.has("error_description")) callbackValue(current, "error_description", 1, 512);
      throw new Error(`OIDC authorization failed (${providerError})`);
    }
    const code = callbackValue(current, "code", 8, 4_096);
    return this.#exchangeCode(configuration, code, transaction.codeVerifier);
  }

  clearTransaction(): void {
    try {
      this.#runtime.storage.removeItem(TRANSACTION_KEY);
    } catch {
      throw new Error("browser OIDC transaction storage is unavailable");
    }
  }

  async #exchangeCode(configuration: BrowserOidcConfiguration, code: string, codeVerifier: string): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: configuration.redirectUri,
      client_id: configuration.clientId,
      code_verifier: codeVerifier,
    });
    const abort = new AbortController();
    const timeout = globalThis.setTimeout(() => abort.abort(), 10_000);
    let response: Response;
    try {
      response = await this.#runtime.fetch(configuration.tokenEndpoint, {
        method: "POST",
        headers: { "accept": "application/json", "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: form,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
    } catch {
      throw new Error("OIDC token exchange failed closed");
    } finally {
      globalThis.clearTimeout(timeout);
    }
    if (response.redirected || response.url !== configuration.tokenEndpoint) throw new Error("OIDC token endpoint redirected");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/^application\/json(?:\s*;[^\r\n]+)?$/.test(contentType)) throw new Error("OIDC token response is not JSON");
    const body = await readBoundedBody(response, MAX_TOKEN_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    } catch {
      throw new Error("OIDC token response JSON is invalid");
    }
    if (!response.ok) throw new Error(`OIDC token endpoint rejected the code (${response.status})`);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "refresh_token" in parsed) {
      throw new Error("OIDC token response included a forbidden refresh token");
    }
    const token = closedObject(parsed, ["access_token", "token_type", "expires_in", "scope", "id_token"], "OIDC token response", true);
    const accessToken = validBearer(token.access_token as string);
    if (token.token_type !== "Bearer") throw new Error("OIDC token type is invalid");
    if (!Number.isSafeInteger(token.expires_in) || (token.expires_in as number) < 60 || (token.expires_in as number) > 3_600) {
      throw new Error("OIDC access token lifetime is invalid");
    }
    if (token.scope !== undefined) boundedString(token.scope, "token scope", 1, 1_024);
    if (token.id_token !== undefined) validBearer(token.id_token as string);
    return accessToken;
  }
}

/**
 * Keeps an OIDC access token only inside this module instance. It deliberately
 * has no serialization API and never touches localStorage, sessionStorage,
 * cookies, URLs, DOM attributes, or logs. Without an injected token, requests
 * remain unauthenticated and let the API fail closed.
 */
export class EphemeralBrowserAuthentication {
  #accessToken: string | undefined;
  #purpose: string;

  constructor(purpose = "product_operation") {
    this.#purpose = validPurpose(purpose);
  }

  setBearerToken(accessToken: string, purpose = this.#purpose): void {
    this.#accessToken = validBearer(accessToken);
    this.#purpose = validPurpose(purpose);
  }

  clear(): void {
    this.#accessToken = undefined;
  }

  snapshot(): BrowserAuthenticationSnapshot {
    return Object.freeze({
      mode: this.#accessToken === undefined ? "unauthenticated" : "injected_bearer",
      purpose: this.#purpose,
      hasInjectedBearer: this.#accessToken !== undefined,
    });
  }

  authenticatedHeaders(initial?: HeadersInit, purpose = this.#purpose): Headers {
    const headers = new Headers(initial);
    headers.set("x-purpose", validPurpose(headers.get("x-purpose") ?? purpose));
    if (this.#accessToken === undefined) headers.delete("authorization");
    else headers.set("authorization", `Bearer ${this.#accessToken}`);
    return headers;
  }
}

function validBearer(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 8
    || value.length > 16_384
    || value !== value.trim()
    || /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("a bounded bearer token is required");
  }
  return value;
}

function validPurpose(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 120
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("a bounded request purpose is required");
  }
  return value;
}

function defaultBrowserOidcRuntime(): BrowserOidcRuntime {
  if (typeof window === "undefined" || typeof sessionStorage === "undefined" || typeof crypto === "undefined") {
    throw new Error("browser OIDC runtime is unavailable");
  }
  return {
    storage: sessionStorage,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    randomBytes(length) {
      const value = new Uint8Array(length);
      crypto.getRandomValues(value);
      return value;
    },
    async digestSha256(value) {
      const copy = new Uint8Array(value);
      return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
    },
    replaceUrl(url) {
      window.history.replaceState(null, "", url);
    },
  };
}

function strictHttps(value: unknown, label: string, allowRoot: boolean): URL {
  const text = boundedString(value, label, 1, 1_024);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be HTTPS`); }
  if (
    url.toString() !== text
    || url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || (!allowRoot && url.pathname === "/")
    || url.hostname === "localhost"
    || url.hostname.endsWith(".localhost")
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
  ) throw new Error(`${label} must be a canonical public HTTPS URL`);
  return url;
}

function currentBrowserUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("current browser URL must be HTTPS"); }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.hostname === "localhost"
    || url.hostname.endsWith(".localhost")
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
  ) throw new Error("current browser URL must be a public HTTPS URL");
  return url;
}

function withinIssuerPath(endpoint: URL, issuer: URL): boolean {
  return issuer.pathname === "/" || endpoint.pathname.startsWith(issuer.pathname);
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
    || (pattern !== undefined && !pattern.test(value))
  ) throw new Error(`${label} is invalid`);
  return value;
}

function closedObject<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
  optional = false,
): Record<T[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const allowed = [...keys].sort();
  if ((!optional && (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index]))) ||
      (optional && actual.some((key) => !allowed.includes(key)))) {
    throw new Error(`${label} is not a closed object`);
  }
  return value as Record<T[number], unknown>;
}

function parseTransaction(value: string): BrowserOidcTransaction {
  if (value.length > 2_048) throw new Error("OIDC transaction is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("OIDC transaction is invalid"); }
  const record = closedObject(parsed, TRANSACTION_KEYS, "OIDC transaction");
  if (record.schemaVersion !== "ltm.browser-oidc-transaction.v1") throw new Error("OIDC transaction is invalid");
  const state = boundedString(record.state, "OIDC state", 43, 256, /^[A-Za-z0-9_-]+$/);
  const codeVerifier = boundedString(record.codeVerifier, "PKCE verifier", 43, 128, /^[A-Za-z0-9_-]+$/);
  const redirectUri = strictHttps(record.redirectUri, "transaction redirect URI", false).toString();
  const configurationSha256 = boundedString(record.configurationSha256, "configuration digest", 64, 64, /^[a-f0-9]{64}$/);
  if (!Number.isSafeInteger(record.createdAtMs) || !Number.isSafeInteger(record.expiresAtMs)) throw new Error("OIDC transaction time is invalid");
  return {
    schemaVersion: "ltm.browser-oidc-transaction.v1",
    state,
    codeVerifier,
    redirectUri,
    configurationSha256,
    createdAtMs: record.createdAtMs as number,
    expiresAtMs: record.expiresAtMs as number,
  };
}

function callbackValue(url: URL, name: string, minimum: number, maximum: number): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) throw new Error(`OIDC callback ${name} is invalid`);
  return boundedString(values[0], `OIDC callback ${name}`, minimum, maximum, /^[A-Za-z0-9._~:/+-]+$/);
}

async function configurationDigest(configuration: BrowserOidcConfiguration, runtime: BrowserOidcRuntime): Promise<string> {
  const canonical = JSON.stringify({
    schemaVersion: configuration.schemaVersion,
    issuer: configuration.issuer,
    authorizationEndpoint: configuration.authorizationEndpoint,
    tokenEndpoint: configuration.tokenEndpoint,
    clientId: configuration.clientId,
    redirectUri: configuration.redirectUri,
    scopes: configuration.scopes,
    audience: configuration.audience,
  });
  return hex(await runtime.digestSha256(utf8(canonical)));
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error("OIDC token response is too large");
  if (response.body === null) throw new Error("OIDC token response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error("OIDC token response is too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error("OIDC token response is empty");
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

function base64Url(value: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index] ?? 0;
    const second = value[index + 1];
    const third = value[index + 2];
    result += alphabet[first >> 2];
    result += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) result += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) result += alphabet[third & 63];
  }
  return result;
}
