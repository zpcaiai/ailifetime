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
  /** Server-derived stable operation identity, normally bound to an idempotency key. */
  readonly operationId?: string;
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

export type EvidenceSignatureAlgorithm = "Ed25519";
export type EvidenceReplayPolicy = "reusable" | "single_use";
export type EvidenceStatus = "verified" | "revoked";
export type EvidenceEnvironment = "test" | "sandbox" | "staging" | "production";

export interface UnsignedExternalEvidence {
  readonly version: "ltm.external-evidence.v1";
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly issuer: string;
  readonly provider: string;
  readonly environment: EvidenceEnvironment;
  /** Opaque exact-match scope defined by the consuming capability. */
  readonly scope: string;
  readonly artifactSha256: string;
  /** Optional for legacy attestations; mandatory when applying a business event. */
  readonly canonicalClaimsSha256?: string;
  /** Signed digest of the complete canonical business-event binding. */
  readonly businessEventSha256?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly replayPolicy: EvidenceReplayPolicy;
  readonly algorithm: EvidenceSignatureAlgorithm;
  readonly keyId: string;
}

export interface SignedExternalEvidence extends UnsignedExternalEvidence {
  /** Unpadded base64url Ed25519 signature over the canonical unsigned envelope. */
  readonly signature: string;
}

export interface TrustedEvidenceKey {
  readonly issuer: string;
  readonly provider: string;
  readonly keyId: string;
  readonly algorithm: EvidenceSignatureAlgorithm;
  readonly publicKeyPem: string;
  readonly allowedScopes: readonly string[];
  readonly allowedEnvironments: readonly EvidenceEnvironment[];
  readonly notBefore?: string;
  readonly notAfter?: string;
}

export interface RegisteredExternalEvidence extends SignedExternalEvidence {
  readonly status: EvidenceStatus;
  readonly versionNumber: number;
  readonly verifiedAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly consumedAt: string | null;
  readonly consumptionKeyHash: string | null;
}

export interface RegisterExternalEvidenceInput {
  readonly evidence: SignedExternalEvidence;
  readonly idempotencyKey: string;
}

export interface RevokeExternalEvidenceInput {
  readonly evidenceId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * A provider-authenticated business fact whose claims are canonicalized before
 * entering the core transaction boundary. The claims digest prevents an
 * adapter, queue, or API hop from silently changing verified provider facts.
 */
export interface VerifiedBusinessEvent {
  readonly version: "ltm.external-business-event.v1";
  readonly eventId: string;
  readonly tenantId: string;
  readonly batchId: `B${string}`;
  readonly operation: string;
  readonly provider: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly eventType: string;
  readonly providerOccurredAt: string;
  /** Provider sequence when one exists; otherwise timestamp ordering is used. */
  readonly sequence: number | null;
  readonly correlationId: string;
  readonly artifactSha256: string;
  readonly evidenceId: string;
  readonly evidenceScope: string;
  readonly canonicalClaims: JsonObject;
  readonly canonicalClaimsSha256: string;
  /** Digest of every event routing, ordering, correlation, artifact, and claims field. */
  readonly businessEventSha256: string;
}

export type ExternalCommandState =
  | "requested"
  | "dispatched"
  | "acknowledged"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "compensated";

export type ExternalDecisionState = "active" | "frozen";
export type ExternalReconciliationState = "clear" | "reconciliation_required";

export interface ExternalCommandRecord {
  readonly commandId: string;
  readonly tenantId: string;
  readonly batchId: `B${string}`;
  readonly operation: string;
  readonly aggregateCollection: string;
  readonly aggregateId: string;
  readonly state: ExternalCommandState;
  readonly providerOperationId: string | null;
  readonly evidenceId: string | null;
  readonly decisionState: ExternalDecisionState;
  readonly reconciliationState: ExternalReconciliationState;
  readonly version: number;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
  readonly details: JsonObject;
}

export interface TransitionExternalCommandInput {
  readonly commandId: string;
  readonly batchId: `B${string}`;
  readonly operation: string;
  readonly aggregateCollection: string;
  readonly aggregateId: string;
  readonly toState: ExternalCommandState;
  readonly providerOperationId?: string | null;
  readonly evidenceId?: string | null;
  readonly details?: JsonObject;
  readonly idempotencyKey: string;
}

export interface CreateExternalCommandInput<T extends JsonObject = JsonObject> {
  readonly record: Omit<CreateRecordInput<T>, "idempotencyKey">;
  readonly commandId?: string;
  readonly batchId: `B${string}`;
  readonly operation: string;
  readonly details?: JsonObject;
  readonly idempotencyKey: string;
}

export interface CreatedExternalCommand<T extends JsonObject = JsonObject> {
  readonly record: RecordEnvelope<T>;
  readonly command: ExternalCommandRecord;
}

export interface ExternalBusinessAggregateTarget {
  readonly collection: string;
  readonly aggregateId: string;
  readonly ownerActorId?: string | null;
  readonly participantIds?: readonly string[];
  readonly containsMinor?: boolean;
  readonly relatedRecords?: readonly {
    readonly key: string;
    readonly collection: string;
    readonly id: string;
    readonly required?: boolean;
    readonly lock?: "share" | "update";
  }[];
}

export interface ExternalBusinessReduction {
  readonly stateField?: string;
  /** null authorizes creation; strings authorize exact current states. */
  readonly allowedPriorStates: readonly (string | null)[];
  readonly nextState: string;
  readonly patch: JsonObject;
  readonly decisionType: string;
  readonly decisionId: string;
  readonly commandTransition?: Omit<TransitionExternalCommandInput, "batchId" | "operation" | "aggregateCollection" | "aggregateId" | "idempotencyKey">;
  readonly ledger?: Omit<PostLedgerInput, "idempotencyKey">;
}

export interface ExternalBusinessReducerContext {
  readonly current: RecordEnvelope | null;
  readonly relatedRecords: Readonly<Record<string, RecordEnvelope | null>>;
}

/** Trusted, compile-time reducer selected by the API registry, never HTTP input. */
export interface ExternalBusinessEventReducer {
  readonly name: string;
  locate(event: VerifiedBusinessEvent): ExternalBusinessAggregateTarget;
  reduce(event: VerifiedBusinessEvent, context: ExternalBusinessReducerContext): ExternalBusinessReduction;
}

export interface ExternalBusinessEventReducerRegistry {
  resolve(event: VerifiedBusinessEvent): ExternalBusinessEventReducer | undefined;
}

export interface ApplyExternalBusinessEventInput {
  readonly event: VerifiedBusinessEvent;
  /** The same Ed25519 envelope is inserted and consumed in this transaction. */
  readonly evidence: SignedExternalEvidence;
  /** Supplied only by trusted application wiring after registry resolution. */
  readonly reducer: ExternalBusinessEventReducer;
  readonly idempotencyKey: string;
}

export interface AppliedExternalBusinessEvent {
  readonly eventId: string;
  readonly provider: string;
  readonly inboxEventId: string;
  readonly aggregate: RecordEnvelope;
  readonly previousState: string | null;
  readonly nextState: string;
  readonly decisionType: string;
  readonly decisionId: string;
  readonly command: ExternalCommandRecord | null;
  readonly ledgerTransaction: LedgerTransaction | null;
  readonly appliedAt: string;
}

export interface BackupVerification {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly schemaVersion: number;
  readonly integrity: "ok";
  readonly auditChainsValid: boolean;
  readonly tenantCount: number;
  readonly recordCount: number;
  readonly auditEntryCount: number;
  readonly evidenceCount: number;
  readonly verifiedAt: string;
}

export interface RuntimeOptions {
  readonly databasePath: string;
  readonly clock?: RuntimeClock;
  readonly busyTimeoutMs?: number;
  readonly trustedEvidenceKeys?: readonly TrustedEvidenceKey[];
  readonly evidencePolicy?: "disabled" | "development" | "production";
  readonly evidenceEnvironment?: EvidenceEnvironment;
  readonly evidenceClockSkewMs?: number;
  readonly maxEvidenceLifetimeMs?: number;
}

export interface PostgresRuntimeOptions {
  /** PostgreSQL connection URL for a non-superuser role without BYPASSRLS. */
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly poolMax?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly clock?: RuntimeClock;
  readonly trustedEvidenceKeys?: readonly TrustedEvidenceKey[];
  readonly evidencePolicy?: "disabled" | "development" | "production";
  readonly evidenceEnvironment?: EvidenceEnvironment;
  readonly evidenceClockSkewMs?: number;
  readonly maxEvidenceLifetimeMs?: number;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly database: "ok" | "error";
  readonly auditChain: "ok" | "error";
  readonly evidenceTrust: "ok" | "disabled" | "error";
}

export type RuntimeBackend = "sqlite" | "postgresql";
export type MaybePromise<T> = T | Promise<T>;

/**
 * Storage-independent runtime contract. PostgreSQL implementations are
 * asynchronous; callers must always await values returned by this port.
 */
export interface LifeTimeMachineRuntimePort {
  readonly backend: RuntimeBackend;
  close(): MaybePromise<void>;
  createVerifiedBackup(destinationPathValue: string): Promise<BackupVerification>;
  readiness(): MaybePromise<ReadinessResult>;
  authorize(context: ActorContext, action: string, resource?: AuthorizationResource): void;
  registerExternalEvidence(
    context: ActorContext,
    input: RegisterExternalEvidenceInput,
  ): MaybePromise<IdempotentResult<RegisteredExternalEvidence>>;
  requireExternalEvidence(
    context: ActorContext,
    scopeValue: string,
    evidenceIds: readonly string[],
  ): MaybePromise<readonly RegisteredExternalEvidence[]>;
  getExternalEvidence(context: ActorContext, evidenceIdValue: string): MaybePromise<RegisteredExternalEvidence>;
  listExternalEvidence(
    context: ActorContext,
    options?: { readonly scope?: string; readonly limit?: number },
  ): MaybePromise<readonly RegisteredExternalEvidence[]>;
  revokeExternalEvidence(
    context: ActorContext,
    input: RevokeExternalEvidenceInput,
  ): MaybePromise<IdempotentResult<RegisteredExternalEvidence>>;
  applyExternalBusinessEvent(
    context: ActorContext,
    input: ApplyExternalBusinessEventInput,
  ): MaybePromise<IdempotentResult<AppliedExternalBusinessEvent>>;
  transitionExternalCommand(
    context: ActorContext,
    input: TransitionExternalCommandInput,
  ): MaybePromise<IdempotentResult<ExternalCommandRecord>>;
  getExternalCommand(context: ActorContext, commandIdValue: string): MaybePromise<ExternalCommandRecord>;
  createExternalCommand<T extends JsonObject>(
    context: ActorContext,
    input: CreateExternalCommandInput<T>,
  ): MaybePromise<IdempotentResult<CreatedExternalCommand<T>>>;
  createRecord<T extends JsonObject>(
    context: ActorContext,
    input: CreateRecordInput<T>,
  ): MaybePromise<IdempotentResult<RecordEnvelope<T>>>;
  getRecord<T extends JsonObject>(
    context: ActorContext,
    collectionValue: string,
    idValue: string,
  ): MaybePromise<RecordEnvelope<T>>;
  listRecords<T extends JsonObject>(
    context: ActorContext,
    input: ListRecordsInput,
  ): MaybePromise<readonly RecordEnvelope<T>[]>;
  updateRecord<T extends JsonObject>(
    context: ActorContext,
    input: UpdateRecordInput<T>,
  ): MaybePromise<IdempotentResult<RecordEnvelope<T>>>;
  deleteRecord(context: ActorContext, input: DeleteRecordInput): MaybePromise<IdempotentResult<RecordEnvelope>>;
  grantConsent(context: ActorContext, input: GrantConsentInput): MaybePromise<IdempotentResult<ConsentRecord>>;
  withdrawConsent(context: ActorContext, input: WithdrawConsentInput): MaybePromise<IdempotentResult<ConsentRecord>>;
  requireConsent(context: ActorContext, requirement: ConsentRequirement): MaybePromise<readonly ConsentRecord[]>;
  listConsents(context: ActorContext, participantIdValue?: string): MaybePromise<readonly ConsentRecord[]>;
  postLedgerTransaction(
    context: ActorContext,
    input: PostLedgerInput,
  ): MaybePromise<IdempotentResult<LedgerTransaction>>;
  getLedgerTransaction(context: ActorContext, transactionIdValue: string): MaybePromise<LedgerTransaction>;
  getAccountBalance(
    context: ActorContext,
    accountCodeValue: string,
    currencyValue: string,
  ): MaybePromise<AccountBalance>;
  getTrialBalance(context: ActorContext): MaybePromise<readonly AccountBalance[]>;
  receiveInboxEvent(context: ActorContext, input: ReceiveInboxInput): MaybePromise<IdempotentResult<InboxEvent>>;
  getInboxEvent(context: ActorContext, eventIdValue: string): MaybePromise<InboxEvent>;
  markInboxProcessed(context: ActorContext, eventIdValue: string, rejected?: boolean): MaybePromise<InboxEvent>;
  listOutbox(
    context: ActorContext,
    options?: { readonly status?: OutboxStatus; readonly limit?: number },
  ): MaybePromise<readonly OutboxEvent[]>;
  claimOutbox(
    context: ActorContext,
    workerIdValue: string,
    limitValue?: number,
    leaseMs?: number,
  ): MaybePromise<readonly OutboxEvent[]>;
  markOutboxPublished(context: ActorContext, eventIdValue: string, workerIdValue: string): MaybePromise<OutboxEvent>;
  markOutboxFailed(
    context: ActorContext,
    eventIdValue: string,
    workerIdValue: string,
    errorValue: string,
    options?: { readonly retryAt?: string; readonly dead?: boolean },
  ): MaybePromise<OutboxEvent>;
  publishOutbox(
    context: ActorContext,
    publisher: OutboxPublisher | undefined,
    options?: { readonly workerId?: string; readonly limit?: number; readonly leaseMs?: number },
  ): Promise<{ readonly published: number; readonly failed: number }>;
  appendAudit(context: ActorContext, input: AppendAuditInput): MaybePromise<AuditEntry>;
  listAudit(context: ActorContext, limitValue?: number): MaybePromise<readonly AuditEntry[]>;
  verifyAuditChain(context: ActorContext): MaybePromise<AuditVerification>;
}
