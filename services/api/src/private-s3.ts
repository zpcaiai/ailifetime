import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand, GetBucketVersioningCommand } from "@aws-sdk/client-s3";
import { DomainError } from "@ltm/core";
import type { PrivateImageObjects } from "./generated-media.js";

export interface PrivateS3Configuration {
  endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string;
  testLoopback?: true;
}
/** Uses authenticated S3 calls only. Does not publish URLs, ACLs, or proxy provider URLs. */
export class PrivateS3Images implements PrivateImageObjects {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(config: PrivateS3Configuration) {
    const url = new URL(config.endpoint);
    const test = config.testLoopback === true && process.env.APP_ENV === "test" && url.hostname === "127.0.0.1" && url.protocol === "http:";
    if ((!test && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !config.region || !config.accessKeyId || !config.secretAccessKey) throw new DomainError("CONFIGURATION_INVALID","private S3 configuration is invalid");
    const tos = /^tos-s3-[a-z0-9-]+\.volces\.com$/.test(url.hostname);
    // TOS S3 supports virtual hosts only. Dotted buckets trigger the SDK's
    // TLS/path-style fallback, which TOS cannot serve.
    if (tos && (url.hostname !== `tos-s3-${config.region}.volces.com` || config.bucket.includes("."))) throw new DomainError("CONFIGURATION_INVALID","TOS S3 region or bucket configuration is invalid");
    this.bucket = config.bucket;
    this.client = new S3Client({ endpoint: url.origin, region: config.region, forcePathStyle: !tos, maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 20_000, throwOnRequestTimeout: true, socketTimeout: 20_000 },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  }
  private key(key: string): string {
    if (!/^generated\/[a-f0-9]{64}\.png$/.test(key)) throw new DomainError("VALIDATION_FAILED","invalid generated object key");
    return key;
  }
  private async unversioned(): Promise<void> {
    // DeleteObject in a versioned or suspended bucket merely creates a delete
    // marker. A404 there would not prove that stored photo versions were removed.
    const versioning=await this.client.send(new GetBucketVersioningCommand({Bucket:this.bucket}));
    if (versioning.Status) throw new DomainError("CONFIGURATION_INVALID","30-day photo deletion requires an unversioned bucket");
  }
  async readiness(): Promise<void> {
    await this.client.send(new HeadBucketCommand({Bucket:this.bucket}));
    await this.unversioned();
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (!bytes.byteLength || bytes.byteLength > 25*1024*1024) throw new DomainError("VALIDATION_FAILED","invalid object size");
    this.key(key);await this.unversioned();
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: bytes,
        ContentType: "image/png", ContentLength: bytes.byteLength, CacheControl: "private, no-store", IfNoneMatch: "*" }));
    } catch (error) {
      // A previous upload may have completed before its SQL transaction committed.
      // The caller verifies exact existing bytes before advancing the journal.
      if (!(typeof error === "object" && error !== null && "$metadata" in error && (error.$metadata as {httpStatusCode?:number}).httpStatusCode === 412)) throw error;
    }
  }
  async get(key: string, maximumBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 25*1024*1024) throw new DomainError("VALIDATION_FAILED","invalid object read size");
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
    const body = response.Body;
    if (!body || !(Symbol.asyncIterator in body)) throw new DomainError("DEPENDENCY_UNAVAILABLE","object body is unavailable");
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      length += chunk.byteLength;
      if (length > maximumBytes) throw new DomainError("DEPENDENCY_UNAVAILABLE","object exceeds its immutable size");
      chunks.push(chunk);
    }
    if (length !== maximumBytes) throw new DomainError("DEPENDENCY_UNAVAILABLE","object has an unexpected size");
    return Buffer.concat(chunks);
  }
  async remove(key: string): Promise<void> { this.key(key);await this.unversioned();await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async exists(key: string): Promise<boolean> {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) })); return true; }
    catch (error) {
      if (error instanceof Error && ["NotFound","NoSuchKey"].includes(error.name) && "$metadata" in error && (error.$metadata as {httpStatusCode?:number}).httpStatusCode === 404) return false;
      throw error;
    }
  }
  close(): void { this.client.destroy(); }
}
