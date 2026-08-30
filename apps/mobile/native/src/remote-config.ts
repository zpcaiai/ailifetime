import { verifyAsync } from "@noble/ed25519";
import { toByteArray } from "base64-js";
import { validateRemoteConfig, type MobileRemoteConfig } from "../../src/production";
import { parseCanonicalJson } from "./canonical-json";
import type { RuntimeConfig } from "./runtime";
import { validateAppNavigation } from "./security";

export class SignedRemoteConfigClient {
  #latestRevision = 0;
  constructor(private readonly runtime: RuntimeConfig) {}

  async refresh(): Promise<MobileRemoteConfig> {
    // Expo Updates authenticates the application bundle. The separately signed
    // config remains independently verifiable and cannot silently fall back to
    // an unauthenticated or nonexistent mobile API route.
    const raw = this.runtime.remoteConfigDocument;
    const signature = strictBase64(this.runtime.remoteConfigSignature, 64, "REMOTE_CONFIG_SIGNATURE_INVALID");
    const publicKey = strictBase64(this.runtime.remoteConfigPublicKey, 32, "REMOTE_CONFIG_PUBLIC_KEY_INVALID");
    if (!(await verifyAsync(signature, new TextEncoder().encode(raw), publicKey))) throw new Error("REMOTE_CONFIG_SIGNATURE_INVALID");
    const config = validateRemoteConfig(parseCanonicalJson(raw), this.runtime.appVersion);
    if (config.revision <= this.#latestRevision) throw new Error("REMOTE_CONFIG_REVISION_STALE");
    for (const route of Object.values(config.routes)) validateAppNavigation(route.path);
    this.#latestRevision = config.revision;
    return config;
  }
}

function strictBase64(value: string, expectedLength: number, code: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(code);
  const bytes = toByteArray(value);
  if (bytes.byteLength !== expectedLength) throw new Error(code);
  return bytes;
}
