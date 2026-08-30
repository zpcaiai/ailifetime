import { toByteArray } from "base64-js";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";
import {
  ResumableUploadCoordinator,
  type ResumableUploadApi,
  type UploadBinding,
  type UploadChunkSource,
  type UploadNetworkPort,
} from "../../src/production";
import { MobileApiClient } from "./api-client";
import { EncryptedUploadSessionStore } from "./native-cache";
import { validatePrivateMediaUri } from "./security";
import {
  parseChunkAccepted,
  parseUploadCancelled,
  parseUploadCompleted,
  parseUploadCreated,
  uploadContentRange,
  uploadCreateBody,
} from "./upload-contract";

export class NativeUploadService {
  readonly state = new EncryptedUploadSessionStore();
  readonly coordinator: ResumableUploadCoordinator;

  constructor(api: MobileApiClient) {
    this.coordinator = new ResumableUploadCoordinator(
      new ServerUploadApi(api), this.state, new NativeChunkSource(), new NativeDigest(), new NativeNetwork(),
    );
  }

  async begin(uri: string, binding: UploadBinding, idempotencyKey: string) {
    validatePrivateMediaUri(uri);
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || typeof info.size !== "number" || info.size < 1 || info.size > 25 * 1_024 * 1_024) throw new Error("UPLOAD_FILE_INVALID");
    const encoded = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    const digest = hex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, copiedBuffer(toByteArray(encoded))));
    return this.coordinator.create({ binding, sourceUri: uri, totalBytes: info.size, wholeFileSha256: digest, idempotencyKey });
  }

  async resume(uploadId: string, binding: UploadBinding, lowDataMode: boolean, background = false) {
    return this.coordinator.resume(uploadId, binding, { lowDataMode, maxChunks: background ? 4 : 32 });
  }
}

class ServerUploadApi implements ResumableUploadApi {
  constructor(private readonly api: MobileApiClient) {}
  async create(input: Parameters<ResumableUploadApi["create"]>[0]) {
    const response = await this.api.request<unknown>("/v1/uploads", {
      purpose: "age_transformation", idempotencyKey: input.idempotencyKey,
      body: uploadCreateBody(input),
    });
    return parseUploadCreated(response);
  }
  async putChunk(input: Parameters<ResumableUploadApi["putChunk"]>[0]) {
    const response = await this.api.request<unknown>(`/v1/uploads/${encodeURIComponent(input.uploadId)}/chunks`, {
      method: "POST", purpose: "age_transformation", idempotencyKey: input.idempotencyKey,
      binaryBody: input.bytes, contentRange: uploadContentRange(input), contentSha256: input.sha256, timeoutMs: 60_000,
    });
    return parseChunkAccepted(response, input.offset + input.bytes.byteLength);
  }
  async complete(input: Parameters<ResumableUploadApi["complete"]>[0]) {
    const response = await this.api.request<unknown>(`/v1/uploads/${encodeURIComponent(input.uploadId)}/complete`, {
      purpose: "age_transformation", idempotencyKey: input.idempotencyKey,
      body: { fileDigest: input.wholeFileSha256, digestAlgorithm: "sha256" }, timeoutMs: 60_000,
    });
    return parseUploadCompleted(response, input.uploadId);
  }
  async cancel(input: Parameters<ResumableUploadApi["cancel"]>[0]): Promise<void> {
    const response = await this.api.request<unknown>(`/v1/uploads/${encodeURIComponent(input.uploadId)}/cancel`, {
      purpose: "age_transformation", idempotencyKey: `${input.uploadId}:cancel:${input.reason}`, body: {},
    });
    parseUploadCancelled(response);
  }
}

class NativeChunkSource implements UploadChunkSource {
  async read(uri: string, offset: number, length: number): Promise<Uint8Array> {
    validatePrivateMediaUri(uri);
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, position: offset, length });
    return toByteArray(base64);
  }
  async remove(uri: string): Promise<void> { await FileSystem.deleteAsync(validatePrivateMediaUri(uri), { idempotent: true }); }
}
class NativeDigest {
  async sha256(bytes: Uint8Array): Promise<string> { return hex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, copiedBuffer(bytes))); }
}
class NativeNetwork implements UploadNetworkPort {
  async current(): Promise<{ readonly connected: boolean; readonly metered: boolean }> {
    const state = await Network.getNetworkStateAsync();
    return { connected: state.isConnected === true && state.isInternetReachable !== false, metered: state.type === Network.NetworkStateType.CELLULAR };
  }
}
function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
