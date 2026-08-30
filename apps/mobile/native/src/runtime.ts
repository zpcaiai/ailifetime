import Constants from "expo-constants";
import * as Application from "expo-application";

export type AppEnvironment = "development" | "test" | "staging" | "production";

export interface RuntimeConfig {
  readonly appEnvironment: AppEnvironment;
  readonly apiOrigin: string;
  readonly apiHost: string;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly remoteConfigPublicKey: string;
  readonly remoteConfigDocument: string;
  readonly remoteConfigSignature: string;
  readonly apiPrimaryPins: readonly string[];
  readonly apiBackupPins: readonly string[];
  readonly pinValidFrom: string;
  readonly pinValidUntil: string;
  readonly projectId: string;
  readonly appVersion: string;
}

export function runtimeConfig(extraValue: unknown = Constants.expoConfig?.extra): RuntimeConfig {
  if (!plain(extraValue)) throw new Error("MOBILE_RUNTIME_CONFIG_MISSING");
  const appEnvironment = exactEnvironment(extraValue.appEnvironment);
  const apiOrigin = exactOrigin(extraValue.apiOrigin, appEnvironment === "development");
  const oidcIssuer = exactIssuer(extraValue.oidcIssuer, appEnvironment === "development");
  const oidcClientId = bounded(extraValue.oidcClientId, "OIDC_CLIENT_ID", 6, 180, /^[A-Za-z0-9._:-]+$/);
  const remoteConfigPublicKey = bounded(extraValue.remoteConfigPublicKey, "REMOTE_CONFIG_PUBLIC_KEY", 43, 128, /^[A-Za-z0-9+/=_-]+$/);
  const remoteConfigDocument = signedDocument(extraValue.remoteConfigDocument);
  const remoteConfigSignature = bounded(extraValue.remoteConfigSignature, "REMOTE_CONFIG_SIGNATURE", 88, 88, /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/);
  const apiPrimaryPins = pins(extraValue.apiPrimaryPins, "PRIMARY_PINS");
  const apiBackupPins = pins(extraValue.apiBackupPins, "BACKUP_PINS");
  if (apiPrimaryPins.some((pin) => apiBackupPins.includes(pin))) throw new Error("TLS_PIN_SETS_OVERLAP");
  const pinValidFrom = instant(extraValue.pinValidFrom, "PIN_VALID_FROM");
  const pinValidUntil = instant(extraValue.pinValidUntil, "PIN_VALID_UNTIL");
  if (Date.parse(pinValidUntil) - Date.now() < 7 * 86_400_000 || Date.parse(pinValidFrom) > Date.now()) {
    throw new Error("TLS_PIN_ROTATION_WINDOW_INVALID");
  }
  const eas = plain(extraValue.eas) ? extraValue.eas : {};
  const projectId = bounded(eas.projectId, "EXPO_PROJECT_ID", 8, 128, /^[A-Za-z0-9-]+$/);
  const appVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "0.0.0";
  if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error("APPLICATION_VERSION_INVALID");
  return Object.freeze({
    appEnvironment, apiOrigin, apiHost: new URL(apiOrigin).hostname, oidcIssuer, oidcClientId,
    remoteConfigPublicKey, remoteConfigDocument, remoteConfigSignature,
    apiPrimaryPins, apiBackupPins, pinValidFrom, pinValidUntil, projectId, appVersion,
  });
}

export function exactOrigin(value: unknown, allowLoopback: boolean): string {
  if (typeof value !== "string" || value !== value.trim()) throw new Error("API_ORIGIN_INVALID");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("API_ORIGIN_INVALID"); }
  const loopback = /^(?:127\.0\.0\.1|localhost)$/.test(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && loopback)) ||
      url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
      (!loopback && !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname))) {
    throw new Error("API_ORIGIN_INVALID");
  }
  return url.origin;
}

function exactIssuer(value: unknown, allowLoopback: boolean): string {
  const origin = exactOrigin(value, allowLoopback);
  return `${origin}/`;
}

function exactEnvironment(value: unknown): AppEnvironment {
  if (value !== "development" && value !== "test" && value !== "staging" && value !== "production") {
    throw new Error("APP_ENVIRONMENT_INVALID");
  }
  return value;
}

function pins(value: unknown, label: string): readonly string[] {
  if (typeof value !== "string" || value !== value.trim()) throw new Error(`${label}_INVALID`);
  const result = value.split(",");
  if (result.length < 1 || result.length > 4 || new Set(result).size !== result.length ||
      result.some((pin) => !/^[A-Za-z0-9+/]{43}=$/.test(pin))) throw new Error(`${label}_INVALID`);
  return Object.freeze(result);
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || !Number.isFinite(Date.parse(value))) throw new Error(`${label}_INVALID`);
  return new Date(value).toISOString();
}

function bounded(value: unknown, label: string, minimum: number, maximum: number, pattern: RegExp): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < minimum || value.length > maximum || !pattern.test(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
}

function signedDocument(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 50 || value.length > 64 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error("REMOTE_CONFIG_DOCUMENT_INVALID");
  }
  return value;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
