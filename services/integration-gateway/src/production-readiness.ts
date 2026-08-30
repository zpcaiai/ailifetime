import {
  DescribeKeyCommand,
  GenerateDataKeyWithoutPlaintextCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import {
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ProductionIntegrationError } from "@ltm/providers";
import type { ApiExternalBusinessEventOutput } from "./evidence-output.js";

export interface ProductionDependencyReadinessResult {
  readonly ready: boolean;
  readonly checks: {
    readonly evidenceBucketAccessible: boolean;
    readonly evidenceBucketVersioning: boolean;
    readonly evidenceBucketObjectLock: boolean;
    readonly evidenceKmsKey: boolean;
    readonly evidenceKmsDataKeyWithoutPlaintext: boolean;
    readonly apiEvidenceRegister: boolean;
    readonly apiExternalEventApply: boolean;
  };
}

interface ReadinessCommandClient {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
}

interface EvidenceSinkPreflight {
  preflightPermissions(): Promise<{
    readonly actorId: string;
    readonly tenantId: string;
    readonly permissions: readonly ["evidence:register", "external-event:apply"];
  }>;
}

export interface ProductionDependencyReadinessOptions {
  readonly bucket: string;
  readonly kmsKeyId: string;
  readonly tenantId: string;
  readonly cacheTtlMs?: number;
  readonly clock?: () => number;
}

/**
 * Live production dependency verification. A successful probe is cached only
 * briefly; every missing permission or incomplete durability control remains a
 * hard not-ready result.
 */
export class ProductionDependencyReadiness {
  readonly #cacheTtlMs: number;
  readonly #clock: () => number;
  readonly #s3: ReadinessCommandClient;
  readonly #kms: ReadinessCommandClient;
  readonly #api: EvidenceSinkPreflight;
  #cached: { readonly expiresAt: number; readonly result: ProductionDependencyReadinessResult } | undefined;
  #inflight: Promise<ProductionDependencyReadinessResult> | undefined;

  constructor(
    private readonly options: ProductionDependencyReadinessOptions,
    api: ApiExternalBusinessEventOutput | EvidenceSinkPreflight,
    clients: {
      readonly s3?: ReadinessCommandClient;
      readonly kms?: ReadinessCommandClient;
    } = {},
  ) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes("..")) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence readiness bucket is invalid");
    }
    if (options.kmsKeyId.trim().length < 1 || options.kmsKeyId.length > 2_048 || /[\u0000-\u001f\u007f]/.test(options.kmsKeyId)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence readiness KMS key ID is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.tenantId)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence readiness tenant ID is invalid");
    }
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    if (!Number.isSafeInteger(this.#cacheTtlMs) || this.#cacheTtlMs < 1_000 || this.#cacheTtlMs > 60_000) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "readiness cache TTL must be between one and sixty seconds");
    }
    this.#clock = options.clock ?? Date.now;
    this.#api = api;
    this.#s3 = clients.s3 ?? (new S3Client({}) as unknown as ReadinessCommandClient);
    this.#kms = clients.kms ?? (new KMSClient({}) as unknown as ReadinessCommandClient);
  }

  async check(): Promise<ProductionDependencyReadinessResult> {
    const now = this.#clock();
    if (this.#cached !== undefined && now < this.#cached.expiresAt) return this.#cached.result;
    if (this.#inflight !== undefined) return this.#inflight;
    const pending = this.#probe().then((result) => {
      this.#cached = { expiresAt: this.#clock() + this.#cacheTtlMs, result };
      return result;
    }).finally(() => {
      if (this.#inflight === pending) this.#inflight = undefined;
    });
    this.#inflight = pending;
    return pending;
  }

  close(): void {
    this.#s3.destroy?.();
    this.#kms.destroy?.();
  }

  async #probe(): Promise<ProductionDependencyReadinessResult> {
    let evidenceBucketAccessible = false;
    let evidenceBucketVersioning = false;
    let evidenceBucketObjectLock = false;
    let evidenceKmsKey = false;
    let evidenceKmsDataKeyWithoutPlaintext = false;
    let apiEvidenceRegister = false;
    let apiExternalEventApply = false;

    try {
      await this.#s3.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      evidenceBucketAccessible = true;
    } catch {
      evidenceBucketAccessible = false;
    }
    try {
      const response = record(await this.#s3.send(new GetBucketVersioningCommand({ Bucket: this.options.bucket })));
      evidenceBucketVersioning = response.Status === "Enabled";
    } catch {
      evidenceBucketVersioning = false;
    }
    try {
      const response = record(await this.#s3.send(new GetObjectLockConfigurationCommand({ Bucket: this.options.bucket })));
      evidenceBucketObjectLock = recordOrEmpty(response.ObjectLockConfiguration).ObjectLockEnabled === "Enabled";
    } catch {
      evidenceBucketObjectLock = false;
    }
    try {
      const response = record(await this.#kms.send(new DescribeKeyCommand({ KeyId: this.options.kmsKeyId })));
      const metadata = recordOrEmpty(response.KeyMetadata);
      evidenceKmsKey = metadata.Enabled === true && metadata.KeyState === "Enabled" &&
        metadata.KeyUsage === "ENCRYPT_DECRYPT" &&
        (metadata.KeySpec === "SYMMETRIC_DEFAULT" || metadata.CustomerMasterKeySpec === "SYMMETRIC_DEFAULT");
    } catch {
      evidenceKmsKey = false;
    }
    if (evidenceKmsKey) {
      try {
        const response = record(await this.#kms.send(new GenerateDataKeyWithoutPlaintextCommand({
          KeyId: this.options.kmsKeyId,
          KeySpec: "AES_256",
          EncryptionContext: {
            "ltm:purpose": "integration-gateway-readiness",
            "ltm:tenant": this.options.tenantId,
          },
        })));
        const ciphertext = response.CiphertextBlob;
        evidenceKmsDataKeyWithoutPlaintext = ciphertext instanceof Uint8Array && ciphertext.byteLength >= 16 &&
          !Object.prototype.hasOwnProperty.call(response, "Plaintext");
      } catch {
        evidenceKmsDataKeyWithoutPlaintext = false;
      }
    }
    try {
      const preflight = await this.#api.preflightPermissions();
      const sameTenant = preflight.tenantId === this.options.tenantId;
      apiEvidenceRegister = sameTenant && preflight.permissions[0] === "evidence:register";
      apiExternalEventApply = sameTenant && preflight.permissions[1] === "external-event:apply";
    } catch {
      apiEvidenceRegister = false;
      apiExternalEventApply = false;
    }

    const checks = {
      evidenceBucketAccessible,
      evidenceBucketVersioning,
      evidenceBucketObjectLock,
      evidenceKmsKey,
      evidenceKmsDataKeyWithoutPlaintext,
      apiEvidenceRegister,
      apiExternalEventApply,
    };
    return { ready: Object.values(checks).every(Boolean), checks };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return record(value);
}
