export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type Role =
  | "consumer"
  | "household_admin"
  | "guardian"
  | "partner_employee"
  | "partner_admin"
  | "studio_operator"
  | "support_agent"
  | "moderator"
  | "privacy_officer"
  | "finance_operator"
  | "platform_admin"
  | "auditor"
  | "service_account";

export interface ActorContext {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
  readonly permissions?: readonly string[];
  readonly purpose: string;
  readonly requestId: string;
  readonly stepUp?: boolean;
  readonly guardianVerified?: boolean;
}

export interface AuthorizationResource {
  readonly tenantId?: string;
  readonly ownerActorId?: string | null;
  readonly containsMinor?: boolean;
  readonly sensitive?: boolean;
}

export interface RecordEnvelope<T extends JsonObject = JsonObject> {
  readonly id: string;
  readonly tenantId: string;
  readonly collection: string;
  readonly ownerActorId: string | null;
  readonly participantIds: readonly string[];
  readonly containsMinor: boolean;
  readonly data: T;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface CreateRecordInput<T extends JsonObject = JsonObject> {
  readonly collection: string;
  readonly id?: string;
  readonly data: T;
  readonly ownerActorId?: string | null;
  readonly participantIds?: readonly string[];
  readonly containsMinor?: boolean;
  readonly idempotencyKey: string;
}

export interface UpdateRecordInput<T extends JsonObject = JsonObject> {
  readonly collection: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly data: T;
  readonly ownerActorId?: string | null;
  readonly participantIds?: readonly string[];
  readonly containsMinor?: boolean;
  readonly idempotencyKey: string;
}

export interface DeleteRecordInput {
  readonly collection: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface ListRecordsInput {
  readonly collection: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeDeleted?: boolean;
}

export interface IdempotentResult<T> {
  readonly value: T;
  readonly replayed: boolean;
}

export type ConsentStatus = "active" | "expired" | "withdrawn" | "disputed" | "superseded";
export type GrantorCapacity = "self" | "guardian" | "authorized_agent";

export interface ConsentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly participantId: string;
  readonly grantorActorId: string;
  readonly grantorCapacity: GrantorCapacity;
  readonly purpose: string;
  readonly scope: JsonObject;
  readonly policyVersion: string;
  readonly status: ConsentStatus;
  readonly evidenceHash: string;
  readonly isMinor: boolean;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly withdrawnAt: string | null;
  readonly version: number;
}

export interface GrantConsentInput {
  readonly id?: string;
  readonly participantId: string;
  readonly grantorCapacity: GrantorCapacity;
  readonly purpose: string;
  readonly scope: JsonObject;
  readonly policyVersion: string;
  readonly evidenceHash: string;
  readonly isMinor?: boolean;
  readonly expiresAt?: string | null;
  readonly idempotencyKey: string;
}

export interface WithdrawConsentInput {
  readonly consentId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ConsentRequirement {
  readonly participantIds: readonly string[];
  readonly purpose?: string;
  readonly at?: string;
}

export type LedgerDirection = "debit" | "credit";

export interface LedgerLine {
  readonly accountCode: string;
  readonly direction: LedgerDirection;
  readonly amountMinor: number;
  readonly currency: string;
  readonly memo?: string;
}

export interface LedgerTransaction {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly description: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly reversedTransactionId: string | null;
  readonly lines: readonly LedgerLine[];
}

export interface PostLedgerInput {
  readonly transactionId?: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly description: string;
  readonly occurredAt?: string;
  readonly reversedTransactionId?: string | null;
  readonly lines: readonly LedgerLine[];
  readonly idempotencyKey: string;
}

export interface AccountBalance {
  readonly accountCode: string;
  readonly currency: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly netMinor: number;
}

export interface InboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly source: string;
  readonly sourceEventId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly status: "received" | "processed" | "rejected";
  readonly receivedAt: string;
  readonly processedAt: string | null;
}

export interface ReceiveInboxInput {
  readonly source: string;
  readonly sourceEventId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
}

export type OutboxStatus = "pending" | "leased" | "published" | "dead";

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseUntil: string | null;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly lastError: string | null;
}

export interface OutboxPublisher {
  publish(event: OutboxEvent): void | Promise<void>;
}

export interface AuditEntry {
  readonly sequence: number;
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly purpose: string;
  readonly requestId: string;
  readonly details: JsonObject;
  readonly previousHash: string;
  readonly hash: string;
  readonly createdAt: string;
}

export interface AppendAuditInput {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly details?: JsonObject;
}

export interface AuditVerification {
  readonly valid: boolean;
  readonly entriesChecked: number;
  readonly invalidSequence: number | null;
}

export interface RuntimeClock {
  now(): Date;
}

export interface ExternalEvidenceVerifier {
  /** Returns the subset of IDs verified against a server-side evidence source. */
  verify(context: ActorContext, scope: string, evidenceIds: readonly string[]): readonly string[];
}

export interface RuntimeOptions {
  readonly databasePath: string;
  readonly clock?: RuntimeClock;
  readonly busyTimeoutMs?: number;
  readonly externalEvidenceVerifier?: ExternalEvidenceVerifier;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly database: "ok" | "error";
  readonly auditChain: "ok" | "error";
}
