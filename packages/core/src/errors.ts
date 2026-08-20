import type { JsonObject } from "./types.js";

export type DomainErrorCode =
  | "AUTH_UNAUTHENTICATED"
  | "AUTH_FORBIDDEN"
  | "TENANT_SCOPE_MISMATCH"
  | "PURPOSE_REQUIRED"
  | "VALIDATION_FAILED"
  | "RESOURCE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "CONSENT_REQUIRED"
  | "CONSENT_WITHDRAWN"
  | "GUARDIAN_VERIFICATION_REQUIRED"
  | "LEDGER_UNBALANCED"
  | "LEDGER_IMMUTABLE"
  | "EVENT_FINGERPRINT_CONFLICT"
  | "EXTERNAL_EVIDENCE_UNVERIFIED"
  | "EXTERNAL_ADAPTER_UNAVAILABLE"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Readonly<Record<DomainErrorCode, number>> = {
  AUTH_UNAUTHENTICATED: 401,
  AUTH_FORBIDDEN: 403,
  TENANT_SCOPE_MISMATCH: 403,
  PURPOSE_REQUIRED: 400,
  VALIDATION_FAILED: 422,
  RESOURCE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CONSENT_REQUIRED: 409,
  CONSENT_WITHDRAWN: 409,
  GUARDIAN_VERIFICATION_REQUIRED: 409,
  LEDGER_UNBALANCED: 422,
  LEDGER_IMMUTABLE: 409,
  EVENT_FINGERPRINT_CONFLICT: 409,
  EXTERNAL_EVIDENCE_UNVERIFIED: 422,
  EXTERNAL_ADAPTER_UNAVAILABLE: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: JsonObject;

  constructor(
    code: DomainErrorCode,
    message: string,
    options: { readonly httpStatus?: number; readonly retryable?: boolean; readonly details?: JsonObject } = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
