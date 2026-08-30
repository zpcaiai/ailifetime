import AsyncStorage from "@react-native-async-storage/async-storage";
import { gcm } from "@noble/ciphers/aes.js";
import { fromByteArray, toByteArray } from "base64-js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  RevocableOfflineCache,
  type CipherPort,
  type NamespacedCacheStore,
  type UploadSessionState,
  type UploadSessionStore,
} from "../../src/production";

const CACHE_KEY = "ltm.mobile.cache-key.v1";
const UPLOAD_PREFIX = "ltm.mobile.upload-state.v1:";
const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  keychainService: "ltm.mobile.local-encryption",
};

export class SecureAesGcmCipher implements CipherPort {
  async seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<string> {
    const key = await loadOrCreateKey();
    const nonce = await Crypto.getRandomBytesAsync(12);
    const ciphertext = gcm(key, nonce, associatedData).encrypt(plaintext);
    return `v1.${fromByteArray(nonce)}.${fromByteArray(ciphertext)}`;
  }

  async open(sealed: string, associatedData: Uint8Array): Promise<Uint8Array> {
    const parts = sealed.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw new Error("CACHE_ENVELOPE_INVALID");
    const nonce = strictBase64(parts[1]!, 12, "CACHE_NONCE_INVALID");
    const ciphertext = strictBase64(parts[2]!, undefined, "CACHE_CIPHERTEXT_INVALID");
    if (ciphertext.byteLength < 17 || ciphertext.byteLength > 1_048_592) throw new Error("CACHE_CIPHERTEXT_INVALID");
    const key = await loadExistingKey();
    return gcm(key, nonce, associatedData).decrypt(ciphertext);
  }
}

export class AsyncStorageNamespace implements NamespacedCacheStore {
  async get(key: string): Promise<string | null> { return AsyncStorage.getItem(key); }
  async set(key: string, value: string): Promise<void> { await AsyncStorage.setItem(key, value); }
  async delete(key: string): Promise<void> { await AsyncStorage.removeItem(key); }
  async keys(prefix: string): Promise<readonly string[]> {
    return (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
  }
}

export function createOfflineCache(): RevocableOfflineCache {
  return new RevocableOfflineCache(new AsyncStorageNamespace(), new SecureAesGcmCipher(), { namespace: "ltm.mobile.cache.v1" });
}

export class EncryptedUploadSessionStore implements UploadSessionStore {
  readonly #cipher = new SecureAesGcmCipher();
  async load(uploadId: string): Promise<UploadSessionState | null> {
    const key = uploadKey(uploadId);
    const envelope = await AsyncStorage.getItem(key);
    if (envelope === null) return null;
    try {
      const plaintext = await this.#cipher.open(envelope, aad(uploadId));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (!plain(parsed) || parsed.schemaVersion !== "ltm.mobile.upload.v1" || parsed.uploadId !== uploadId) throw new Error("UPLOAD_STATE_INVALID");
      return parsed as unknown as UploadSessionState;
    } catch (error) {
      await AsyncStorage.removeItem(key);
      throw new Error("UPLOAD_STATE_AUTHENTICATION_FAILED", { cause: error });
    }
  }
  async save(state: UploadSessionState): Promise<void> {
    const key = uploadKey(state.uploadId);
    const envelope = await this.#cipher.seal(new TextEncoder().encode(JSON.stringify(state)), aad(state.uploadId));
    await AsyncStorage.setItem(key, envelope);
  }
  async delete(uploadId: string): Promise<void> { await AsyncStorage.removeItem(uploadKey(uploadId)); }
  async listIds(): Promise<readonly string[]> {
    return (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(UPLOAD_PREFIX)).map((key) => key.slice(UPLOAD_PREFIX.length));
  }
  async purgeAll(): Promise<void> {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(UPLOAD_PREFIX) || key.startsWith("ltm.mobile.cache.v1:"));
    if (keys.length > 0) await AsyncStorage.multiRemove(keys);
    await SecureStore.deleteItemAsync(CACHE_KEY, KEY_OPTIONS);
  }
}

async function loadOrCreateKey(): Promise<Uint8Array> {
  if (!(await SecureStore.isAvailableAsync())) throw new Error("SECURE_STORAGE_UNAVAILABLE");
  const existing = await SecureStore.getItemAsync(CACHE_KEY, KEY_OPTIONS);
  if (existing !== null) return strictBase64(existing, 32, "CACHE_KEY_INVALID");
  const key = await Crypto.getRandomBytesAsync(32);
  await SecureStore.setItemAsync(CACHE_KEY, fromByteArray(key), KEY_OPTIONS);
  return key;
}

async function loadExistingKey(): Promise<Uint8Array> {
  const value = await SecureStore.getItemAsync(CACHE_KEY, KEY_OPTIONS);
  if (value === null) throw new Error("CACHE_KEY_UNAVAILABLE");
  return strictBase64(value, 32, "CACHE_KEY_INVALID");
}

function strictBase64(value: string, length: number | undefined, code: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(code);
  const bytes = toByteArray(value);
  if (length !== undefined && bytes.byteLength !== length || fromByteArray(bytes) !== value) throw new Error(code);
  return bytes;
}
function uploadKey(uploadId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(uploadId)) throw new Error("UPLOAD_ID_INVALID");
  return `${UPLOAD_PREFIX}${uploadId}`;
}
function aad(uploadId: string): Uint8Array { return new TextEncoder().encode(`ltm.mobile.upload-state.aad.v1:${uploadId}`); }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
