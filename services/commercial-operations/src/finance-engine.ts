import {
  CommercialOperationsError,
  assertActor,
  assertExactKeys,
  basisPoints,
  canonicalJson,
  conflict,
  currency,
  dateOnly,
  exactUtc,
  freeze,
  identifier,
  minor,
  nonEmpty,
  requireAuthorization,
  requireState,
  sha256,
  signedMinor,
  sortedUnique,
  type CommercialActor,
  type JsonObject,
  type JsonValue,
} from "./common.js";
import { CommercialFactVerifier, type SignedCommercialFact, type VerifiedCommercialFact } from "./signed-facts.js";
import type { AggregateSnapshot, CommercialOperationsRepository } from "./store.js";

const FINANCE_ROLES = ["finance_operator", "finance_admin", "platform_admin"] as const;
const REVIEW_ROLES = ["finance_admin", "auditor", "platform_admin"] as const;
const POSTING_KINDS = ["payment", "refund", "credit", "gift", "tax", "fee", "partner_share", "vendor_cost"] as const;
type PostingKind = typeof POSTING_KINDS[number];

interface AccountDefinition extends JsonObject {
  readonly code: string;
  readonly name: string;
  readonly class: "asset" | "liability" | "equity" | "revenue" | "expense";
  readonly normalSide: "debit" | "credit";
}

interface PostingRule extends JsonObject {
  readonly eventKind: PostingKind;
  readonly version: string;
  readonly debitAccount: string;
  readonly creditAccount: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

interface JournalLine extends JsonObject {
  readonly accountCode: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly currency: string;
}

interface JournalEntryState extends JsonObject {
  readonly entryId: string;
  readonly legalEntityId: string;
  readonly period: string;
  readonly occurredAt: string;
  readonly eventKind: PostingKind | "reversal" | "adjustment";
  readonly sourceReference: string;
  readonly ruleVersion: string;
  readonly lines: readonly JournalLine[];
  readonly reversalOf: string | null;
  readonly adjustmentOfPeriod: string | null;
  readonly status: "posted" | "reversed";
}

interface PeriodState extends JsonObject {
  readonly period: string;
  readonly legalEntityId: string;
  readonly state: "open" | "soft_closed" | "hard_closed";
  readonly approvals: readonly string[];
  readonly checklistDigest: string | null;
  readonly reopenedAt: string | null;
}

export interface FinanceEngineOptions {
  readonly repository: CommercialOperationsRepository;
  readonly factVerifier: CommercialFactVerifier;
  readonly clock?: () => Date;
}

/** Dedicated B87-B94 accounting and commercial-finance engine. */
export class FinanceOperationsEngine {
  readonly #repository: CommercialOperationsRepository;
  readonly #facts: CommercialFactVerifier;
  readonly #clock: () => Date;

  constructor(options: FinanceEngineOptions) {
    this.#repository = options.repository;
    this.#facts = options.factVerifier;
    this.#clock = options.clock ?? (() => new Date());
  }

  // B87 — authoritative chart, posting rules, immutable journals and periods.
  configureLedger(actor: CommercialActor, input: {
    readonly legalEntityId: string;
    readonly currency: string;
    readonly chartVersion: string;
    readonly accounts: readonly AccountDefinition[];
    readonly postingRules: readonly PostingRule[];
    readonly idempotencyKey: string;
  }): AggregateSnapshot {
    assertActor(actor, REVIEW_ROLES);
    const legalEntityId = identifier(input.legalEntityId, "legalEntityId");
    const currencyCode = currency(input.currency);
    const accounts = input.accounts.map((account) => validateAccount(account));
    if (accounts.length < 2 || new Set(accounts.map((account) => account.code)).size !== accounts.length) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "ledger chart requires unique accounts");
    }
    const codes = new Set(accounts.map((account) => account.code));
    const rules = input.postingRules.map((rule) => validatePostingRule(rule, codes));
    if (new Set(rules.map((rule) => `${rule.eventKind}:${rule.version}`)).size !== rules.length) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "posting rule identity is duplicated");
    }
    const id = `${legalEntityId}:${currencyCode}`;
    const request = { legalEntityId, currency: currencyCode, chartVersion: identifier(input.chartVersion, "chartVersion"), accounts, postingRules: rules };
    return this.#repository.execute({
      tenantId: actor.tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "B87.configureLedger",
      request,
      run: () => this.#repository.put({
        tenantId: actor.tenantId,
        aggregateType: "finance.ledgerConfig",
        aggregateId: id,
        expectedVersion: this.#repository.get(actor.tenantId, "finance.ledgerConfig", id)?.version ?? null,
        state: { ...request, approvedBy: actor.actorId },
        eventType: "finance.ledgerConfigured",
        event: { chartVersion: request.chartVersion, accountCount: accounts.length, ruleCount: rules.length },
      }) as unknown as JsonValue,
    }).value as unknown as AggregateSnapshot;
  }

  postJournal(actor: CommercialActor, input: {
    readonly entryId: string;
    readonly legalEntityId: string;
    readonly currency: string;
    readonly eventKind: PostingKind;
    readonly amountMinor: number;
    readonly sourceReference: string;
    readonly occurredAt: string;
    readonly ruleVersion: string;
    readonly adjustmentPeriod?: string;
    readonly softCloseApprovals?: readonly string[];
    readonly idempotencyKey: string;
  }): JournalEntryState {
    assertActor(actor, FINANCE_ROLES);
    if (!POSTING_KINDS.includes(input.eventKind)) throw new CommercialOperationsError("VALIDATION_FAILED", "posting event kind is unsupported");
    const occurredAt = exactUtc(input.occurredAt, "occurredAt");
    const sourcePeriod = occurredAt.slice(0, 7);
    const config = this.#required<JsonObject>(actor.tenantId, "finance.ledgerConfig", `${input.legalEntityId}:${input.currency}`);
    const rules = config.state.postingRules as unknown as PostingRule[];
    const rule = rules.find((candidate) => candidate.eventKind === input.eventKind && candidate.version === input.ruleVersion &&
      candidate.effectiveFrom <= occurredAt && (candidate.effectiveUntil === null || candidate.effectiveUntil >= occurredAt));
    if (rule === undefined) throw new CommercialOperationsError("POLICY_BLOCKED", "no effective approved posting rule matches the event");
    const period = this.#period(actor.tenantId, input.legalEntityId, sourcePeriod);
    let postingPeriod = sourcePeriod;
    let adjustmentOfPeriod: string | null = null;
    if (period.state.state === "hard_closed") {
      if (input.adjustmentPeriod === undefined) throw new CommercialOperationsError("PERIOD_LOCKED", "hard-closed period requires a formal current-period adjustment");
      postingPeriod = validPeriod(input.adjustmentPeriod);
      if (postingPeriod <= sourcePeriod) throw new CommercialOperationsError("PERIOD_LOCKED", "adjustment period must follow the locked source period");
      adjustmentOfPeriod = sourcePeriod;
    } else if (period.state.state === "soft_closed") {
      const approvals = sortedUnique(input.softCloseApprovals ?? [], "softCloseApprovals", 2);
      requireAuthorization(!approvals.includes(actor.actorId), "soft-close override executor must be independent");
    }
    this.#assertSourceReferenceUnused(actor.tenantId, input.legalEntityId, input.sourceReference);
    const amount = minor(input.amountMinor);
    const lines: readonly JournalLine[] = freeze([
      { accountCode: rule.debitAccount, debitMinor: amount, creditMinor: 0, currency: input.currency },
      { accountCode: rule.creditAccount, debitMinor: 0, creditMinor: amount, currency: input.currency },
    ]);
    assertBalanced(lines);
    const state: JournalEntryState = freeze({
      entryId: identifier(input.entryId, "entryId"),
      legalEntityId: identifier(input.legalEntityId, "legalEntityId"),
      period: postingPeriod,
      occurredAt,
      eventKind: adjustmentOfPeriod === null ? input.eventKind : "adjustment",
      sourceReference: identifier(input.sourceReference, "sourceReference", 256),
      ruleVersion: identifier(input.ruleVersion, "ruleVersion"),
      lines,
      reversalOf: null,
      adjustmentOfPeriod,
      status: "posted",
    });
    return this.#repository.execute({
      tenantId: actor.tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "B87.postJournal",
      request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId,
        aggregateType: "finance.journal",
        aggregateId: state.entryId,
        expectedVersion: null,
        state,
        eventType: "finance.journalPosted",
        event: state,
      }).state,
    }).value as JournalEntryState;
  }

  reverseJournal(actor: CommercialActor, input: {
    readonly entryId: string;
    readonly originalEntryId: string;
    readonly reason: string;
    readonly occurredAt: string;
    readonly idempotencyKey: string;
  }): JournalEntryState {
    assertActor(actor, REVIEW_ROLES);
    const original = this.#required<JournalEntryState>(actor.tenantId, "finance.journal", input.originalEntryId);
    requireState(original.state.status === "posted", "only a posted journal can be reversed once");
    const existingReversal = this.#repository.listEvents(actor.tenantId, "finance.journal").find((event) => event.payload.reversalOf === input.originalEntryId);
    if (existingReversal !== undefined) conflict("journal entry was already reversed");
    const state: JournalEntryState = {
      ...original.state,
      entryId: identifier(input.entryId, "entryId"),
      occurredAt: exactUtc(input.occurredAt, "occurredAt"),
      eventKind: "reversal",
      sourceReference: `reversal:${original.state.entryId}`,
      lines: original.state.lines.map((line) => ({ ...line, debitMinor: line.creditMinor, creditMinor: line.debitMinor })),
      reversalOf: original.state.entryId,
      status: "posted",
    };
    assertBalanced(state.lines);
    return this.#repository.execute({
      tenantId: actor.tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "B87.reverseJournal",
      request: { originalEntryId: input.originalEntryId, entryId: input.entryId, reason: nonEmpty(input.reason, "reason"), occurredAt: state.occurredAt },
      run: () => {
        this.#repository.put({
          tenantId: actor.tenantId,
          aggregateType: "finance.journal",
          aggregateId: original.aggregateId,
          expectedVersion: original.version,
          state: { ...original.state, status: "reversed" },
          eventType: "finance.journalReversed",
          event: { reversalEntryId: state.entryId, reason: input.reason },
        });
        return this.#repository.put({
          tenantId: actor.tenantId,
          aggregateType: "finance.journal",
          aggregateId: state.entryId,
          expectedVersion: null,
          state,
          eventType: "finance.reversalPosted",
          event: { ...state, reason: input.reason },
        }).state;
      },
    }).value as JournalEntryState;
  }

  setPeriodState(actor: CommercialActor, input: {
    readonly legalEntityId: string;
    readonly period: string;
    readonly state: PeriodState["state"];
    readonly approvals: readonly string[];
    readonly checklistDigest?: string;
    readonly idempotencyKey: string;
  }): PeriodState {
    assertActor(actor, REVIEW_ROLES);
    const period = validPeriod(input.period);
    const id = `${identifier(input.legalEntityId, "legalEntityId")}:${period}`;
    const current = this.#repository.get<PeriodState>(actor.tenantId, "finance.period", id);
    const from = current?.state.state ?? "open";
    if (from === "hard_closed" && input.state !== "hard_closed") {
      throw new CommercialOperationsError("PERIOD_LOCKED", "hard-closed period requires the dedicated two-person reopen command");
    }
    if (input.state === "hard_closed") {
      const approvals = sortedUnique(input.approvals, "approvals", 2);
      requireAuthorization(!approvals.includes(actor.actorId), "hard close executor must be independent");
      if (!/^[a-f0-9]{64}$/.test(input.checklistDigest ?? "")) throw new CommercialOperationsError("VALIDATION_FAILED", "hard close requires checklist digest");
    }
    const state: PeriodState = {
      period,
      legalEntityId: input.legalEntityId,
      state: input.state,
      approvals: freeze([...input.approvals]),
      checklistDigest: input.checklistDigest ?? null,
      reopenedAt: current?.state.reopenedAt ?? null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "B87.setPeriodState",
      request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId,
        aggregateType: "finance.period",
        aggregateId: id,
        expectedVersion: current?.version ?? null,
        state,
        eventType: `finance.period.${input.state}`,
        event: { from, to: input.state, approvals: input.approvals },
      }).state,
    }).value as PeriodState;
  }

  trialBalance(tenantId: string, legalEntityId: string, currencyCode: string, throughPeriod?: string): Readonly<JsonObject> {
    const balances = new Map<string, number>();
    let debits = 0;
    let credits = 0;
    for (const event of this.#repository.listEvents(tenantId, "finance.journal")) {
      if (event.eventType !== "finance.journalPosted" && event.eventType !== "finance.reversalPosted") continue;
      const payload = event.payload as unknown as JournalEntryState;
      if (payload.legalEntityId !== legalEntityId || (throughPeriod !== undefined && payload.period > throughPeriod)) continue;
      for (const line of payload.lines) {
        if (line.currency !== currencyCode) continue;
        debits += line.debitMinor;
        credits += line.creditMinor;
        balances.set(line.accountCode, (balances.get(line.accountCode) ?? 0) + line.debitMinor - line.creditMinor);
      }
    }
    if (debits !== credits) throw new CommercialOperationsError("CONFLICT", "trial balance is not balanced");
    return freeze({
      legalEntityId,
      currency: currencyCode,
      throughPeriod: throughPeriod ?? null,
      debitMinor: debits,
      creditMinor: credits,
      accounts: Object.fromEntries([...balances.entries()].sort()) as JsonObject,
      balanced: true,
    });
  }

  // B88 — signed statements, deterministic matching and explicit discrepancy cases.
  ingestSettlementStatement(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "payment.statement");
    assertExactKeys(verified.payload, ["statementId", "legalEntityId", "currency", "fileSha256", "sourceManifestSha256", "lines"], "payment statement");
    const statementId = identifier(String(verified.payload.statementId), "statementId");
    if (statementId !== verified.subjectId || !/^[a-f0-9]{64}$/.test(String(verified.payload.fileSha256)) ||
        !/^[a-f0-9]{64}$/.test(String(verified.payload.sourceManifestSha256)) || !Array.isArray(verified.payload.lines)) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "payment statement fact payload is invalid");
    }
    const lines = verified.payload.lines.map((line, index) => validateStatementLine(line, index));
    const state: JsonObject = {
      statementId,
      provider: verified.provider,
      legalEntityId: identifier(String(verified.payload.legalEntityId), "legalEntityId"),
      currency: currency(String(verified.payload.currency)),
      fileSha256: String(verified.payload.fileSha256),
      sourceManifestSha256: String(verified.payload.sourceManifestSha256),
      lines,
      factId: verified.factId,
      factSha256: verified.factSha256,
      status: "imported",
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B88.ingestStatement", state, () =>
      this.#repository.put({
        tenantId: actor.tenantId,
        aggregateType: "finance.statement",
        aggregateId: statementId,
        expectedVersion: null,
        state,
        eventType: "finance.statementImported",
        event: { statementId, lineCount: lines.length, fileSha256: state.fileSha256 },
      }).state);
  }

  reconcileStatement(actor: CommercialActor, input: {
    readonly statementId: string;
    readonly toleranceSeconds: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    if (!Number.isSafeInteger(input.toleranceSeconds) || input.toleranceSeconds < 0 || input.toleranceSeconds > 86_400) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "reconciliation time tolerance is invalid");
    }
    const statement = this.#required<JsonObject>(actor.tenantId, "finance.statement", input.statementId);
    const lines = statement.state.lines as unknown as Array<Record<string, JsonValue>>;
    const journals = this.#repository.listEvents(actor.tenantId, "finance.journal")
      .filter((event) => event.eventType === "finance.journalPosted" || event.eventType === "finance.reversalPosted")
      .map((event) => event.payload as unknown as JournalEntryState);
    const matched: JsonValue[] = [];
    const cases: JsonValue[] = [];
    for (const line of lines) {
      const source = String(line.providerTransactionId);
      const net = Number(line.netMinor);
      const exact = journals.find((entry) => entry.sourceReference === source && entry.lines[0]?.debitMinor === Math.abs(net) &&
        entry.lines[0]?.currency === statement.state.currency &&
        Math.abs(Date.parse(entry.occurredAt) - Date.parse(String(line.occurredAt))) <= input.toleranceSeconds * 1_000);
      if (exact !== undefined) {
        matched.push({ providerTransactionId: source, entryId: exact.entryId, confidence: "exact" });
        continue;
      }
      const sameOrder = journals.filter((entry) => entry.sourceReference.includes(String(line.orderId)));
      cases.push({
        caseId: sha256(`${input.statementId}\n${source}`).slice(0, 32),
        providerTransactionId: source,
        category: sameOrder.length > 0 ? "amount_or_fee" : "missing_or_unknown",
        state: "manual_confirmation_required",
        candidates: sameOrder.map((entry) => entry.entryId),
        assignedTo: null,
        resolutionEntryId: null,
      });
    }
    const next = { ...statement.state, status: cases.length === 0 ? "reconciled" : "differences_open", matched, cases };
    return this.#repository.execute({
      tenantId: actor.tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "B88.reconcileStatement",
      request: { statementId: input.statementId, toleranceSeconds: input.toleranceSeconds },
      run: () => this.#repository.put({
        tenantId: actor.tenantId,
        aggregateType: "finance.statement",
        aggregateId: statement.aggregateId,
        expectedVersion: statement.version,
        state: next,
        eventType: "finance.statementReconciled",
        event: { matchedCount: matched.length, differenceCount: cases.length },
      }).state,
    }).value as JsonObject;
  }

  resolveReconciliationCase(actor: CommercialActor, input: {
    readonly statementId: string;
    readonly caseId: string;
    readonly assigneeId: string;
    readonly resolutionEntryId: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const statement = this.#required<JsonObject>(actor.tenantId, "finance.statement", input.statementId);
    const cases = statement.state.cases as unknown as Array<Record<string, JsonValue>>;
    const index = cases.findIndex((candidate) => candidate.caseId === input.caseId);
    if (index < 0) throw new CommercialOperationsError("NOT_FOUND", "reconciliation case was not found");
    this.#required(actor.tenantId, "finance.journal", input.resolutionEntryId);
    const updatedCases = cases.map((candidate, candidateIndex) => candidateIndex === index
      ? { ...candidate, state: "resolved", assignedTo: identifier(input.assigneeId, "assigneeId"), resolutionEntryId: input.resolutionEntryId }
      : candidate);
    const next = { ...statement.state, cases: updatedCases, status: updatedCases.every((candidate) => candidate.state === "resolved") ? "reconciled" : "differences_open" };
    return this.#repository.execute({
      tenantId: actor.tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "B88.resolveCase",
      request: { statementId: input.statementId, caseId: input.caseId, assigneeId: input.assigneeId, resolutionEntryId: input.resolutionEntryId },
      run: () => this.#repository.put({
        tenantId: actor.tenantId,
        aggregateType: "finance.statement",
        aggregateId: statement.aggregateId,
        expectedVersion: statement.version,
        state: next,
        eventType: "finance.reconciliationCaseResolved",
        event: { caseId: input.caseId, resolutionEntryId: input.resolutionEntryId },
      }).state,
    }).value as JsonObject;
  }

  closeReconciliationWindow(actor: CommercialActor, input: {
    readonly windowId: string;
    readonly statementId: string;
    readonly bankStatementFact: SignedCommercialFact;
    readonly partnerSourceDigest: string;
    readonly materialityMinor: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const statement = this.#required<JsonObject>(actor.tenantId, "finance.statement", input.statementId);
    requireState(statement.state.status === "reconciled", "all reconciliation differences must be resolved before close");
    const bank = this.#verifyFact(input.bankStatementFact, actor.tenantId, "bank.statement", input.windowId);
    assertExactKeys(bank.payload, ["windowId", "statementId", "legalEntityId", "currency", "fileSha256", "controlTotalMinor"], "bank statement fact");
    const statementTotal = (statement.state.lines as unknown as Array<Record<string, JsonValue>>)
      .reduce((sum, line) => sum + Number(line.netMinor), 0);
    if (bank.payload.windowId !== input.windowId || bank.payload.statementId !== input.statementId ||
        bank.payload.legalEntityId !== statement.state.legalEntityId || bank.payload.currency !== statement.state.currency ||
        signedMinor(Number(bank.payload.controlTotalMinor), "bank controlTotalMinor") !== statementTotal ||
        !/^[a-f0-9]{64}$/.test(String(bank.payload.fileSha256))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "bank statement is not independently bound to the reconciled payment statement and control total");
    }
    if (!/^[a-f0-9]{64}$/.test(input.partnerSourceDigest)) throw new CommercialOperationsError("VALIDATION_FAILED", "partner source digest is required independently");
    const state: JsonObject = {
      windowId: input.windowId,
      statementId: input.statementId,
      bankFactId: bank.factId,
      partnerSourceDigest: input.partnerSourceDigest,
      materialityMinor: minor(input.materialityMinor, "materialityMinor", true),
      status: "closed",
      evidenceDigest: sha256(canonicalJson({ statement: statement.state, bankFactSha256: bank.factSha256, partnerSourceDigest: input.partnerSourceDigest })),
    };
    return this.#atomicFact(actor, bank, input.idempotencyKey, "B88.closeWindow", state, () =>
      this.#repository.put({
        tenantId: actor.tenantId,
        aggregateType: "finance.reconciliationWindow",
        aggregateId: input.windowId,
        expectedVersion: null,
        state,
        eventType: "finance.reconciliationWindowClosed",
        event: { evidenceDigest: state.evidenceDigest, materialityMinor: state.materialityMinor },
      }).state);
  }

  // B89 — effective tax profiles, immutable invoice numbering and signed tax-provider facts.
  configureTaxProfile(actor: CommercialActor, input: {
    readonly profileId: string;
    readonly legalEntityId: string;
    readonly jurisdiction: string;
    readonly sellerTaxId: string;
    readonly sellerAddress: string;
    readonly sellerBankReference: string;
    readonly taxRatesBasisPoints: Readonly<Record<string, number>>;
    readonly goodsTaxCategories: Readonly<Record<string, string>>;
    readonly currencies: readonly string[];
    readonly languages: readonly string[];
    readonly numberingSeries: string;
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
    readonly professionalReviewerId: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    requireAuthorization(actor.actorId !== input.professionalReviewerId, "tax profile requires independent professional review");
    const rates = Object.fromEntries(Object.entries(input.taxRatesBasisPoints).map(([key, value]) => [identifier(key, "tax category"), basisPoints(value, "tax rate")])) as JsonObject;
    const categories = Object.fromEntries(Object.entries(input.goodsTaxCategories).map(([key, value]) => [identifier(key, "goods category"), identifier(value, "tax category")])) as JsonObject;
    const effectiveFrom = dateOnly(input.effectiveFrom, "effectiveFrom");
    const effectiveUntil = input.effectiveUntil === null ? null : dateOnly(input.effectiveUntil, "effectiveUntil");
    if (effectiveUntil !== null && effectiveUntil < effectiveFrom) throw new CommercialOperationsError("VALIDATION_FAILED", "tax profile effective range is invalid");
    const state: JsonObject = {
      profileId: identifier(input.profileId, "profileId"), legalEntityId: identifier(input.legalEntityId, "legalEntityId"),
      jurisdiction: identifier(input.jurisdiction, "jurisdiction"), sellerTaxId: nonEmpty(input.sellerTaxId, "sellerTaxId"),
      sellerAddress: nonEmpty(input.sellerAddress, "sellerAddress"), sellerBankReference: identifier(input.sellerBankReference, "sellerBankReference"),
      taxRatesBasisPoints: rates, goodsTaxCategories: categories,
      currencies: sortedUnique(input.currencies.map(currency), "currencies"), languages: sortedUnique(input.languages, "languages"),
      numberingSeries: identifier(input.numberingSeries, "numberingSeries"), effectiveFrom,
      effectiveUntil,
      professionalReviewerId: identifier(input.professionalReviewerId, "professionalReviewerId"), status: "approved",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B89.configureTaxProfile", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "tax.profile", aggregateId: input.profileId,
        expectedVersion: this.#repository.get(actor.tenantId, "tax.profile", input.profileId)?.version ?? null,
        state, eventType: "tax.profileApproved", event: { effectiveFrom: state.effectiveFrom, reviewerId: state.professionalReviewerId },
      }).state,
    }).value as JsonObject;
  }

  requestTaxDocument(actor: CommercialActor, input: {
    readonly requestId: string;
    readonly profileId: string;
    readonly orderId: string;
    readonly documentKind: "consumer_receipt" | "enterprise_invoice" | "electronic_fapiao" | "credit_note";
    readonly buyerTitle?: string;
    readonly buyerTaxId?: string;
    readonly currency: string;
    readonly netMinor: number;
    readonly taxMinor: number;
    readonly originalDocumentId?: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const profile = this.#required<JsonObject>(actor.tenantId, "tax.profile", input.profileId);
    if ((input.documentKind === "enterprise_invoice" || input.documentKind === "electronic_fapiao") &&
        (input.buyerTitle === undefined || input.buyerTaxId === undefined)) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "enterprise tax document requires validated buyer title and tax ID");
    }
    if (input.documentKind === "credit_note" && input.originalDocumentId === undefined) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "credit note must reference the immutable original document");
    }
    if (input.originalDocumentId !== undefined) this.#required(actor.tenantId, "tax.document", input.originalDocumentId);
    const state: JsonObject = {
      requestId: identifier(input.requestId, "requestId"), profileId: input.profileId, legalEntityId: profile.state.legalEntityId,
      orderId: identifier(input.orderId, "orderId"), documentKind: input.documentKind,
      buyerTitle: input.buyerTitle ?? null, buyerTaxId: input.buyerTaxId ?? null,
      currency: currency(input.currency), netMinor: minor(input.netMinor, "netMinor", true), taxMinor: minor(input.taxMinor, "taxMinor", true),
      grossMinor: input.netMinor + input.taxMinor, originalDocumentId: input.originalDocumentId ?? null,
      status: input.documentKind === "consumer_receipt" ? "ready_for_internal_receipt" : "provider_pending",
      providerFailure: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B89.requestTaxDocument", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "tax.documentRequest", aggregateId: input.requestId,
        expectedVersion: null, state, eventType: "tax.documentRequested", event: { documentKind: input.documentKind, grossMinor: state.grossMinor },
      }).state,
    }).value as JsonObject;
  }

  applyTaxDocumentFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "tax.document");
    assertExactKeys(verified.payload, ["requestId", "documentId", "documentNumber", "documentSha256", "status", "taxMinor", "grossMinor"], "tax document fact");
    const requestId = identifier(String(verified.payload.requestId), "requestId");
    const request = this.#required<JsonObject>(actor.tenantId, "tax.documentRequest", requestId);
    if (verified.subjectId !== requestId || verified.payload.status !== "issued" || verified.payload.taxMinor !== request.state.taxMinor ||
        verified.payload.grossMinor !== request.state.grossMinor || !/^[a-f0-9]{64}$/.test(String(verified.payload.documentSha256))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "tax document provider fact does not match the approved request");
    }
    const documentId = identifier(String(verified.payload.documentId), "documentId");
    const number = identifier(String(verified.payload.documentNumber), "documentNumber", 160);
    const numberId = `${String(request.state.legalEntityId)}:${number}`;
    if (this.#repository.get(actor.tenantId, "tax.documentNumber", numberId) !== undefined) conflict("tax document number already exists for this legal entity");
    const state: JsonObject = {
      documentId, requestId, documentNumber: number, documentSha256: String(verified.payload.documentSha256),
      legalEntityId: request.state.legalEntityId, orderId: request.state.orderId, documentKind: request.state.documentKind,
      currency: request.state.currency, netMinor: request.state.netMinor, taxMinor: request.state.taxMinor,
      grossMinor: request.state.grossMinor, originalDocumentId: request.state.originalDocumentId,
      provider: verified.provider, providerFactId: verified.factId, status: "issued", immutable: true,
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B89.applyTaxDocumentFact", state, () => {
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "tax.documentNumber", aggregateId: numberId, expectedVersion: null,
        state: { documentId, number, legalEntityId: request.state.legalEntityId }, eventType: "tax.documentNumberClaimed", event: { documentId, number },
      });
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "tax.documentRequest", aggregateId: request.aggregateId, expectedVersion: request.version,
        state: { ...request.state, status: "issued", documentId }, eventType: "tax.documentRequestCompleted", event: { documentId },
      });
      return this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "tax.document", aggregateId: documentId, expectedVersion: null,
        state, eventType: "tax.documentIssued", event: { documentNumber: number, documentSha256: state.documentSha256 },
      }).state;
    });
  }

  recordTaxProviderFailure(actor: CommercialActor, requestId: string, failureCode: string, idempotencyKey: string): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const request = this.#required<JsonObject>(actor.tenantId, "tax.documentRequest", requestId);
    requireState(request.state.status === "provider_pending", "only pending tax requests can record provider failure");
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey, operation: "B89.recordProviderFailure",
      request: { requestId, failureCode: identifier(failureCode, "failureCode") },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "tax.documentRequest", aggregateId: request.aggregateId, expectedVersion: request.version,
        state: { ...request.state, status: "provider_failed_retriable", providerFailure: failureCode },
        eventType: "tax.documentProviderFailed", event: { failureCode },
      }).state,
    }).value as JsonObject;
  }

  createTaxDocumentAccess(actor: CommercialActor, documentId: string, tokenSha256: string, expiresAt: string, idempotencyKey: string): JsonObject {
    assertActor(actor, [...FINANCE_ROLES, "customer"]);
    const document = this.#required<JsonObject>(actor.tenantId, "tax.document", documentId);
    if (!/^[a-f0-9]{64}$/.test(tokenSha256)) throw new CommercialOperationsError("VALIDATION_FAILED", "tax document token digest is invalid");
    const expiration = exactUtc(expiresAt, "expiresAt");
    if (Date.parse(expiration) <= this.#clock().getTime() || Date.parse(expiration) > this.#clock().getTime() + 15 * 60_000) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "tax document access must expire within fifteen minutes");
    }
    const state: JsonObject = {
      grantId: sha256(`${actor.tenantId}\n${documentId}\n${tokenSha256}`).slice(0, 32), documentId,
      tokenSha256, expiresAt: expiration, watermark: `${actor.actorId}:${document.state.documentNumber}`,
      purpose: actor.purpose, status: "active",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey, operation: "B89.createDocumentAccess",
      request: { documentId, expiresAt: expiration, actorId: actor.actorId, purpose: actor.purpose },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "tax.documentAccess", aggregateId: String(state.grantId), expectedVersion: null,
        state, eventType: "tax.documentAccessGranted", event: { documentId, expiresAt: expiration, watermark: state.watermark },
      }).state,
    }).value as JsonObject;
  }

  authorizeTaxDocumentAccess(tenantId: string, grantId: string, token: string): JsonObject {
    const grant = this.#required<JsonObject>(tenantId, "tax.documentAccess", grantId);
    if (grant.state.status !== "active" || Date.parse(String(grant.state.expiresAt)) <= this.#clock().getTime() || sha256(token) !== grant.state.tokenSha256) {
      throw new CommercialOperationsError("AUTHORIZATION_REQUIRED", "tax document access credential is invalid or expired");
    }
    const document = this.#required<JsonObject>(tenantId, "tax.document", String(grant.state.documentId));
    return freeze({ documentId: document.aggregateId, documentSha256: document.state.documentSha256, watermark: grant.state.watermark, expiresAt: grant.state.expiresAt, immutable: true });
  }

  // B90 — performance obligations and liability-first revenue recognition.
  createRevenueContract(actor: CommercialActor, input: {
    readonly contractId: string;
    readonly contractType: "subscription" | "credit" | "gift" | "digital" | "physical" | "partner_minimum" | "implementation";
    readonly currency: string;
    readonly transactionPriceMinor: number;
    readonly obligations: readonly { readonly obligationId: string; readonly allocatedMinor: number; readonly trigger: "delivery" | "consumption" | "period" | "milestone" }[];
    readonly expiryPolicyReviewed: boolean;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const obligations = input.obligations.map((obligation) => ({
      obligationId: identifier(obligation.obligationId, "obligationId"), allocatedMinor: minor(obligation.allocatedMinor),
      trigger: obligation.trigger, recognizedMinor: 0, state: "unfulfilled",
    }));
    const price = minor(input.transactionPriceMinor);
    if (obligations.reduce((sum, item) => sum + item.allocatedMinor, 0) !== price) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "performance-obligation allocation must equal transaction price");
    }
    if ((input.contractType === "credit" || input.contractType === "gift") && !input.expiryPolicyReviewed) {
      throw new CommercialOperationsError("POLICY_BLOCKED", "credit and gift expiry policy requires legal/accounting review");
    }
    const state: JsonObject = {
      contractId: identifier(input.contractId, "contractId"), contractType: input.contractType, currency: currency(input.currency),
      transactionPriceMinor: price, liabilityMinor: price, recognizedMinor: 0, refundedMinor: 0,
      obligations, scheduleVersion: 1, modifications: [], expiryPolicyReviewed: input.expiryPolicyReviewed, state: "active",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B90.createRevenueContract", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "revenue.contract", aggregateId: input.contractId, expectedVersion: null,
        state, eventType: "revenue.contractCreated", event: { transactionPriceMinor: price, obligationCount: obligations.length },
      }).state,
    }).value as JsonObject;
  }

  recognizeRevenue(actor: CommercialActor, input: {
    readonly contractId: string;
    readonly obligationId: string;
    readonly amountMinor: number;
    readonly trigger: "delivery" | "consumption" | "period" | "milestone" | "cash";
    readonly milestoneFact?: SignedCommercialFact;
    readonly period: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    if (input.trigger === "cash") throw new CommercialOperationsError("POLICY_BLOCKED", "cash collection is not a revenue-recognition trigger");
    const contract = this.#required<JsonObject>(actor.tenantId, "revenue.contract", input.contractId);
    const obligations = contract.state.obligations as unknown as Array<Record<string, JsonValue>>;
    const index = obligations.findIndex((obligation) => obligation.obligationId === input.obligationId);
    if (index < 0) throw new CommercialOperationsError("NOT_FOUND", "performance obligation was not found");
    const obligation = obligations[index] as Record<string, JsonValue>;
    if (obligation.trigger !== input.trigger) throw new CommercialOperationsError("POLICY_BLOCKED", "recognition trigger does not match the approved contract schedule");
    let fact: VerifiedCommercialFact | undefined;
    if (input.trigger !== "period") {
      if (input.milestoneFact === undefined) throw new CommercialOperationsError("EXTERNAL_FACT_REQUIRED", "verifiable delivery or milestone fact is required");
      fact = this.#verifyFact(input.milestoneFact, actor.tenantId, "revenue.milestone", input.obligationId);
      assertExactKeys(fact.payload, ["contractId", "obligationId", "trigger", "achieved", "amountMinor", "sourceReference"], "revenue milestone fact");
      if (fact.payload.contractId !== input.contractId || fact.payload.obligationId !== input.obligationId ||
          fact.payload.trigger !== input.trigger || fact.payload.achieved !== true || fact.payload.amountMinor !== input.amountMinor ||
          typeof fact.payload.sourceReference !== "string" || fact.payload.sourceReference.length < 1) {
        throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "revenue milestone is not bound to the exact contract obligation, trigger, and amount");
      }
    }
    const amount = minor(input.amountMinor);
    const remaining = Number(obligation.allocatedMinor) - Number(obligation.recognizedMinor);
    if (amount > remaining || amount > Number(contract.state.liabilityMinor)) conflict("recognition exceeds the remaining obligation or liability");
    const updated = obligations.map((candidate, candidateIndex) => candidateIndex === index
      ? { ...candidate, recognizedMinor: Number(candidate.recognizedMinor) + amount, state: Number(candidate.recognizedMinor) + amount === Number(candidate.allocatedMinor) ? "fulfilled" : "partially_fulfilled" }
      : candidate);
    const next: JsonObject = {
      ...contract.state,
      obligations: updated,
      liabilityMinor: Number(contract.state.liabilityMinor) - amount,
      recognizedMinor: Number(contract.state.recognizedMinor) + amount,
    };
    const execute = () => this.#repository.put({
      tenantId: actor.tenantId, aggregateType: "revenue.contract", aggregateId: contract.aggregateId, expectedVersion: contract.version,
      state: next, eventType: "revenue.recognized", event: { obligationId: input.obligationId, amountMinor: amount, trigger: input.trigger, period: validPeriod(input.period), factId: fact?.factId ?? null },
    }).state;
    if (fact !== undefined) return this.#atomicFact(actor, fact, input.idempotencyKey, "B90.recognizeRevenue", { contractId: input.contractId, obligationId: input.obligationId, amountMinor: amount, trigger: input.trigger, period: input.period }, execute);
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B90.recognizeRevenue",
      request: { contractId: input.contractId, obligationId: input.obligationId, amountMinor: amount, trigger: input.trigger, period: validPeriod(input.period) }, run: execute,
    }).value as JsonObject;
  }

  modifyRevenueContract(actor: CommercialActor, input: {
    readonly contractId: string;
    readonly modificationId: string;
    readonly type: "upgrade" | "downgrade" | "extension" | "discount" | "refund" | "termination";
    readonly adjustmentMinor: number;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const contract = this.#required<JsonObject>(actor.tenantId, "revenue.contract", input.contractId);
    const adjustment = signedMinor(input.adjustmentMinor, "adjustmentMinor");
    const modifications = contract.state.modifications as unknown as JsonValue[];
    if (modifications.some((entry) => (entry as JsonObject).modificationId === input.modificationId)) conflict("contract modification already exists");
    const nextPrice = Number(contract.state.transactionPriceMinor) + adjustment;
    if (nextPrice < Number(contract.state.recognizedMinor) || Number(contract.state.liabilityMinor) + adjustment < 0) {
      conflict("contract modification would overwrite previously recognized history");
    }
    const modification = { modificationId: identifier(input.modificationId, "modificationId"), type: input.type, adjustmentMinor: adjustment, reason: nonEmpty(input.reason, "reason"), previousScheduleVersion: Number(contract.state.scheduleVersion) };
    const next: JsonObject = {
      ...contract.state,
      transactionPriceMinor: nextPrice,
      liabilityMinor: Number(contract.state.liabilityMinor) + adjustment,
      refundedMinor: input.type === "refund" ? Number(contract.state.refundedMinor) + Math.abs(adjustment) : contract.state.refundedMinor,
      scheduleVersion: Number(contract.state.scheduleVersion) + 1,
      modifications: [...modifications, modification],
      state: input.type === "termination" ? "terminated" : contract.state.state,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B90.modifyContract", request: { contractId: input.contractId, ...modification },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "revenue.contract", aggregateId: contract.aggregateId, expectedVersion: contract.version,
        state: next, eventType: "revenue.contractModified", event: modification,
      }).state,
    }).value as JsonObject;
  }

  revenueReport(tenantId: string, contractId: string): JsonObject {
    const contract = this.#required<JsonObject>(tenantId, "revenue.contract", contractId).state;
    const recognized = Number(contract.recognizedMinor);
    const liability = Number(contract.liabilityMinor);
    return freeze({
      contractId, contractType: contract.contractType, currency: contract.currency,
      mrrMinor: contract.contractType === "subscription" ? recognized : 0,
      arrMinor: contract.contractType === "subscription" ? recognized * 12 : 0,
      deferredMinor: liability, recognizedMinor: recognized, remainingObligationMinor: liability,
      refundedMinor: contract.refundedMinor, scheduleVersion: contract.scheduleVersion,
      accountingBasis: "performance_obligation", cashIsNotProfit: true,
    });
  }

  // B91 — dispute workflow, minimal evidence, human authority and reserve accounting.
  openDispute(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, ["risk_operator", ...FINANCE_ROLES]);
    const verified = this.#verifyFact(fact, actor.tenantId, "payment.dispute");
    assertExactKeys(verified.payload, ["disputeId", "orderId", "reasonCode", "amountMinor", "currency", "responseDueAt", "refunded"], "payment dispute");
    if (verified.subjectId !== verified.payload.disputeId || verified.payload.refunded !== false) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "refunded or misbound payment cannot open a defendable dispute");
    }
    if (Date.parse(String(verified.payload.responseDueAt)) <= this.#clock().getTime()) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "dispute response deadline is already expired");
    const state: JsonObject = {
      disputeId: identifier(String(verified.payload.disputeId), "disputeId"), orderId: identifier(String(verified.payload.orderId), "orderId"),
      reasonCode: identifier(String(verified.payload.reasonCode), "reasonCode"), amountMinor: minor(Number(verified.payload.amountMinor)),
      currency: currency(String(verified.payload.currency)), responseDueAt: exactUtc(String(verified.payload.responseDueAt), "responseDueAt"),
      provider: verified.provider, providerFactId: verified.factId, state: "open", assigneeId: null,
      evidence: [], riskRecommendation: null, humanDecision: null, reserveMinor: Number(verified.payload.amountMinor),
      lossMinor: 0, recoveredMinor: 0, feeMinor: 0, policyReviewRequired: false,
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B91.openDispute", state, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "risk.dispute", aggregateId: String(state.disputeId), expectedVersion: null,
        state, eventType: "risk.disputeOpened", event: { reasonCode: state.reasonCode, amountMinor: state.amountMinor, responseDueAt: state.responseDueAt },
      }).state);
  }

  attachDisputeEvidence(actor: CommercialActor, input: {
    readonly disputeId: string;
    readonly evidenceId: string;
    readonly category: "transaction" | "delivery" | "consent" | "communication_summary";
    readonly artifactSha256: string;
    readonly containsFaceMedia: boolean;
    readonly containsChildData: boolean;
    readonly containsPrivateConversation: boolean;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, ["risk_operator", ...FINANCE_ROLES]);
    if (input.containsFaceMedia || input.containsChildData || input.containsPrivateConversation) {
      throw new CommercialOperationsError("POLICY_BLOCKED", "dispute packet may contain only minimized transaction, delivery, consent, and communication facts");
    }
    if (!/^[a-f0-9]{64}$/.test(input.artifactSha256)) throw new CommercialOperationsError("VALIDATION_FAILED", "evidence artifact digest is invalid");
    const dispute = this.#required<JsonObject>(actor.tenantId, "risk.dispute", input.disputeId);
    requireState(dispute.state.state === "open" || dispute.state.state === "review", "closed dispute evidence is immutable");
    const evidence = dispute.state.evidence as unknown as JsonValue[];
    if (evidence.some((entry) => (entry as JsonObject).evidenceId === input.evidenceId)) conflict("dispute evidence was already attached");
    const entry: JsonObject = {
      evidenceId: identifier(input.evidenceId, "evidenceId"), category: input.category, artifactSha256: input.artifactSha256,
      expiresAt: exactUtc(input.expiresAt, "expiresAt"), minimized: true,
    };
    if (Date.parse(String(entry.expiresAt)) <= this.#clock().getTime() || Date.parse(String(entry.expiresAt)) > this.#clock().getTime() + 30 * 86_400_000) {
      throw new CommercialOperationsError("POLICY_BLOCKED", "dispute evidence access must be short-lived");
    }
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B91.attachEvidence", request: { disputeId: input.disputeId, ...entry },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "risk.dispute", aggregateId: dispute.aggregateId, expectedVersion: dispute.version,
        state: { ...dispute.state, evidence: [...evidence, entry] }, eventType: "risk.disputeEvidenceAttached", event: entry,
      }).state,
    }).value as JsonObject;
  }

  recommendDisputeReview(actor: CommercialActor, input: {
    readonly disputeId: string;
    readonly recommendation: "prioritize" | "normal" | "possible_loss";
    readonly explanationCodes: readonly string[];
    readonly usesSensitiveOrBiometricSignals: boolean;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, ["risk_operator", "service_account", ...FINANCE_ROLES]);
    if (input.usesSensitiveOrBiometricSignals) throw new CommercialOperationsError("POLICY_BLOCKED", "sensitive or biometric signals cannot influence dispute decisions");
    const dispute = this.#required<JsonObject>(actor.tenantId, "risk.dispute", input.disputeId);
    const recommendation = { recommendation: input.recommendation, explanationCodes: sortedUnique(input.explanationCodes, "explanationCodes"), effect: "queue_only" };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B91.recommendReview", request: { disputeId: input.disputeId, ...recommendation },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "risk.dispute", aggregateId: dispute.aggregateId, expectedVersion: dispute.version,
        state: { ...dispute.state, state: "review", riskRecommendation: recommendation }, eventType: "risk.disputeReviewRecommended", event: recommendation,
      }).state,
    }).value as JsonObject;
  }

  decideDispute(actor: CommercialActor, input: {
    readonly disputeId: string;
    readonly decision: "submit_evidence" | "accept_loss";
    readonly explanation: string;
    readonly channelDecisionFact: SignedCommercialFact;
    readonly feeMinor: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, ["risk_manager", "finance_admin", "platform_admin"]);
    const dispute = this.#required<JsonObject>(actor.tenantId, "risk.dispute", input.disputeId);
    requireState(dispute.state.state === "open" || dispute.state.state === "review", "dispute is no longer decidable");
    const fact = this.#verifyFact(input.channelDecisionFact, actor.tenantId, "payment.dispute.decision", input.disputeId);
    assertExactKeys(fact.payload, ["disputeId", "outcome", "amountMinor", "feeMinor", "refunded"], "dispute decision fact");
    if (fact.payload.disputeId !== input.disputeId || fact.payload.amountMinor !== dispute.state.amountMinor ||
        fact.payload.feeMinor !== input.feeMinor || fact.payload.refunded === true) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "dispute decision conflicts with payment/refund truth");
    }
    const outcome = fact.payload.outcome;
    if (!['won', 'lost'].includes(String(outcome))) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "dispute outcome is not terminal");
    const amount = Number(dispute.state.amountMinor);
    const fee = minor(input.feeMinor, "feeMinor", true);
    const state: JsonObject = {
      ...dispute.state, state: outcome === "won" ? "won" : "lost", humanDecision: {
        decision: input.decision, explanation: nonEmpty(input.explanation, "explanation"), actorId: actor.actorId,
      }, reserveMinor: 0, recoveredMinor: outcome === "won" ? amount : 0,
      lossMinor: outcome === "lost" ? amount : 0, feeMinor: fee, channelDecisionFactId: fact.factId,
    };
    return this.#atomicFact(actor, fact, input.idempotencyKey, "B91.decideDispute", { disputeId: input.disputeId, decision: input.decision, explanation: input.explanation, feeMinor: fee }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "risk.dispute", aggregateId: dispute.aggregateId, expectedVersion: dispute.version,
        state, eventType: `risk.dispute.${String(outcome)}`, event: { amountMinor: amount, feeMinor: fee, reserveReleasedMinor: amount, factId: fact.factId },
      }).state);
  }

  evaluateDisputeThresholds(actor: CommercialActor, input: {
    readonly merchantId: string;
    readonly disputeCount: number;
    readonly transactionCount: number;
    readonly falsePositiveBasisPoints: number;
    readonly thresholdBasisPoints: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, ["risk_manager", "finance_admin", "platform_admin"]);
    if (!Number.isSafeInteger(input.disputeCount) || !Number.isSafeInteger(input.transactionCount) || input.transactionCount < 1 || input.disputeCount < 0 || input.disputeCount > input.transactionCount) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "dispute metric denominator is invalid");
    }
    const rate = Math.floor(input.disputeCount * 10_000 / input.transactionCount);
    const review = rate >= basisPoints(input.thresholdBasisPoints, "thresholdBasisPoints") || basisPoints(input.falsePositiveBasisPoints, "falsePositiveBasisPoints") >= 500;
    const state: JsonObject = {
      merchantId: identifier(input.merchantId, "merchantId"), disputeCount: input.disputeCount,
      transactionCount: input.transactionCount, disputeRateBasisPoints: rate,
      falsePositiveBasisPoints: input.falsePositiveBasisPoints, thresholdBasisPoints: input.thresholdBasisPoints,
      policyReviewRequired: review, automaticSafetyRelaxation: false,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B91.evaluateThresholds", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "risk.disputeMetrics", aggregateId: input.merchantId,
        expectedVersion: this.#repository.get(actor.tenantId, "risk.disputeMetrics", input.merchantId)?.version ?? null,
        state, eventType: review ? "risk.policyReviewRequired" : "risk.metricsRecorded", event: { disputeRateBasisPoints: rate, policyReviewRequired: review },
      }).state,
    }).value as JsonObject;
  }

  // B92 — contract-derived partner settlement and controlled payout.
  configurePartnerContract(actor: CommercialActor, input: {
    readonly partnerId: string;
    readonly contractVersion: string;
    readonly effectiveFrom: string;
    readonly effectiveUntil: string;
    readonly commissionBasisPoints: number;
    readonly tierThresholdMinor: number;
    readonly tierCommissionBasisPoints: number;
    readonly withholdingBasisPoints: number;
    readonly holdbackBasisPoints: number;
    readonly refundWindowDays: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    if (!Number.isSafeInteger(input.refundWindowDays) || input.refundWindowDays < 0 || input.refundWindowDays > 365) throw new CommercialOperationsError("VALIDATION_FAILED", "refund window is invalid");
    const effectiveFrom = dateOnly(input.effectiveFrom, "effectiveFrom");
    const effectiveUntil = dateOnly(input.effectiveUntil, "effectiveUntil");
    if (effectiveUntil < effectiveFrom) throw new CommercialOperationsError("VALIDATION_FAILED", "partner contract effective range is invalid");
    const state: JsonObject = {
      partnerId: identifier(input.partnerId, "partnerId"), contractVersion: identifier(input.contractVersion, "contractVersion"),
      effectiveFrom, effectiveUntil,
      commissionBasisPoints: basisPoints(input.commissionBasisPoints), tierThresholdMinor: minor(input.tierThresholdMinor, "tierThresholdMinor", true),
      tierCommissionBasisPoints: basisPoints(input.tierCommissionBasisPoints), withholdingBasisPoints: basisPoints(input.withholdingBasisPoints),
      holdbackBasisPoints: basisPoints(input.holdbackBasisPoints), refundWindowDays: input.refundWindowDays, status: "approved",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B92.configureContract", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "partner.contract", aggregateId: `${input.partnerId}:${input.contractVersion}`, expectedVersion: null,
        state, eventType: "partner.contractApproved", event: { contractVersion: input.contractVersion, effectiveFrom: input.effectiveFrom },
      }).state,
    }).value as JsonObject;
  }

  createPayoutStatement(actor: CommercialActor, input: {
    readonly statementId: string;
    readonly partnerId: string;
    readonly contractVersion: string;
    readonly currency: string;
    readonly period: string;
    readonly lines: readonly { readonly orderId: string; readonly revenueMinor: number; readonly refundMinor: number; readonly feeMinor: number; readonly attributed: boolean }[];
    readonly adjustmentsMinor: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const contract = this.#required<JsonObject>(actor.tenantId, "partner.contract", `${input.partnerId}:${input.contractVersion}`).state;
    const lines = input.lines.map((line) => {
      const revenue = minor(line.revenueMinor, "revenueMinor", true);
      const refund = minor(line.refundMinor, "refundMinor", true);
      const fee = minor(line.feeMinor, "feeMinor", true);
      if (!line.attributed || refund > revenue) throw new CommercialOperationsError("VALIDATION_FAILED", "partner payout line lacks authoritative attribution or exceeds revenue after refunds");
      const eligible = revenue - refund - fee;
      const rate = eligible >= Number(contract.tierThresholdMinor) ? Number(contract.tierCommissionBasisPoints) : Number(contract.commissionBasisPoints);
      const gross = Math.floor(eligible * rate / 10_000);
      const withholding = Math.floor(gross * Number(contract.withholdingBasisPoints) / 10_000);
      const holdback = Math.floor(gross * Number(contract.holdbackBasisPoints) / 10_000);
      return { orderId: identifier(line.orderId, "orderId"), revenueMinor: revenue, refundMinor: refund, feeMinor: fee, eligibleMinor: eligible, rateBasisPoints: rate, grossPayableMinor: gross, withholdingMinor: withholding, holdbackMinor: holdback, netPayableMinor: gross - withholding - holdback };
    });
    const net = lines.reduce((sum, line) => sum + line.netPayableMinor, 0) + signedMinor(input.adjustmentsMinor, "adjustmentsMinor");
    if (net < 0) conflict("partner net payable cannot be negative");
    const state: JsonObject = {
      statementId: identifier(input.statementId, "statementId"), partnerId: identifier(input.partnerId, "partnerId"),
      contractVersion: input.contractVersion, currency: currency(input.currency), period: validPeriod(input.period), lines,
      adjustmentsMinor: input.adjustmentsMinor, netPayableMinor: net, state: "issued", approvals: [],
      bankAccountFactId: null, coolingEndsAt: null, payoutFactId: null, withholdingDocumentId: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B92.createStatement", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "partner.payout", aggregateId: input.statementId, expectedVersion: null,
        state, eventType: "partner.payoutStatementIssued", event: { netPayableMinor: net, lineCount: lines.length, contractVersion: input.contractVersion },
      }).state,
    }).value as JsonObject;
  }

  approvePayout(actor: CommercialActor, input: {
    readonly statementId: string;
    readonly approverIds: readonly string[];
    readonly bankAccountFact: SignedCommercialFact;
    readonly coolingEndsAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES, input.approverIds);
    const payout = this.#required<JsonObject>(actor.tenantId, "partner.payout", input.statementId);
    requireState(payout.state.state === "issued" || payout.state.state === "disputed_resolved", "payout statement is not approvable");
    const fact = this.#verifyFact(input.bankAccountFact, actor.tenantId, "partner.bank-account", String(payout.state.partnerId));
    assertExactKeys(fact.payload, ["partnerId", "accountToken", "verified", "changedAt"], "partner bank account fact");
    if (fact.payload.verified !== true || fact.payload.partnerId !== payout.state.partnerId || !String(fact.payload.accountToken).startsWith("vault:")) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "partner bank account is not strongly verified and tokenized");
    }
    const changedAt = exactUtc(String(fact.payload.changedAt), "bank account changedAt");
    const coolingEndsAt = exactUtc(input.coolingEndsAt, "coolingEndsAt");
    if (Date.parse(coolingEndsAt) < Date.parse(changedAt) + 24 * 60 * 60_000) {
      throw new CommercialOperationsError("POLICY_BLOCKED", "partner bank-account change cooling period is too short");
    }
    const approvals = sortedUnique(input.approverIds, "approverIds", 2);
    return this.#atomicFact(actor, fact, input.idempotencyKey, "B92.approvePayout", { statementId: input.statementId, approverIds: approvals, coolingEndsAt }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "partner.payout", aggregateId: payout.aggregateId, expectedVersion: payout.version,
        state: { ...payout.state, state: "approved", approvals, bankAccountFactId: fact.factId, accountToken: fact.payload.accountToken, coolingEndsAt },
        eventType: "partner.payoutApproved", event: { approvals, bankAccountFactId: fact.factId, coolingEndsAt },
      }).state);
  }

  applyPayoutFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "partner.payout");
    const payout = this.#required<JsonObject>(actor.tenantId, "partner.payout", verified.subjectId);
    requireState(payout.state.state === "approved" || payout.state.state === "payment_failed", "payout is not ready for a provider result");
    if (Date.parse(String(payout.state.coolingEndsAt)) > this.#clock().getTime()) throw new CommercialOperationsError("POLICY_BLOCKED", "bank-account cooling period has not ended");
    assertExactKeys(verified.payload, ["statementId", "amountMinor", "currency", "status", "providerPaymentId"], "partner payout fact");
    if (verified.payload.statementId !== payout.aggregateId || verified.payload.amountMinor !== payout.state.netPayableMinor || verified.payload.currency !== payout.state.currency ||
        !["paid", "failed", "returned"].includes(String(verified.payload.status))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "partner payout fact does not match approved settlement");
    }
    const state = { ...payout.state, state: verified.payload.status, payoutFactId: verified.factId, providerPaymentId: verified.payload.providerPaymentId };
    return this.#atomicFact(actor, verified, idempotencyKey, "B92.applyPayoutFact", { statementId: payout.aggregateId, status: verified.payload.status }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "partner.payout", aggregateId: payout.aggregateId, expectedVersion: payout.version,
        state, eventType: `partner.payout.${String(verified.payload.status)}`, event: { providerPaymentId: verified.payload.providerPaymentId, amountMinor: payout.state.netPayableMinor },
      }).state);
  }

  issueWithholdingDocument(actor: CommercialActor, statementId: string, documentId: string, documentSha256: string, idempotencyKey: string): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const payout = this.#required<JsonObject>(actor.tenantId, "partner.payout", statementId);
    requireState(payout.state.state === "paid", "withholding document requires confirmed partner payment");
    if (!/^[a-f0-9]{64}$/.test(documentSha256)) throw new CommercialOperationsError("VALIDATION_FAILED", "withholding document digest is invalid");
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey, operation: "B92.issueWithholdingDocument", request: { statementId, documentId, documentSha256 },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "partner.payout", aggregateId: payout.aggregateId, expectedVersion: payout.version,
        state: { ...payout.state, withholdingDocumentId: identifier(documentId, "documentId"), withholdingDocumentSha256: documentSha256, reconciliationState: "bank_pending" },
        eventType: "partner.withholdingDocumentIssued", event: { documentId, documentSha256 },
      }).state,
    }).value as JsonObject;
  }

  // B93 — verified cost facts, versioned allocations, safety-preserving budgets and profitability.
  recordCostEvent(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "cost.vendor");
    assertExactKeys(verified.payload, ["costEventId", "category", "amountMinor", "currency", "projectId", "orderId", "tenantId", "partnerId", "channel", "region", "model", "product"], "vendor cost fact");
    if (verified.payload.costEventId !== verified.subjectId || verified.payload.tenantId !== actor.tenantId) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "cost fact is not tenant or subject bound");
    const state: JsonObject = {
      ...verified.payload, amountMinor: minor(Number(verified.payload.amountMinor)), currency: currency(String(verified.payload.currency)),
      provider: verified.provider, factId: verified.factId, factSha256: verified.factSha256, allocated: false,
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B93.recordCostEvent", state, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finops.costEvent", aggregateId: verified.subjectId, expectedVersion: null,
        state, eventType: "finops.costRecorded", event: { category: state.category, amountMinor: state.amountMinor, provider: verified.provider },
      }).state);
  }

  configureAllocationRule(actor: CommercialActor, input: {
    readonly ruleId: string;
    readonly version: string;
    readonly category: string;
    readonly dimensions: readonly string[];
    readonly allocations: readonly { readonly target: string; readonly basisPoints: number }[];
    readonly effectiveFrom: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const allowedDimensions = new Set(["project", "order", "tenant", "partner", "channel", "region", "model", "product"]);
    const dimensions = sortedUnique(input.dimensions, "dimensions");
    if (dimensions.some((dimension) => !allowedDimensions.has(dimension))) throw new CommercialOperationsError("VALIDATION_FAILED", "allocation dimension is unsupported");
    const allocations = input.allocations.map((entry) => ({ target: identifier(entry.target, "allocation target"), basisPoints: basisPoints(entry.basisPoints) }));
    if (allocations.reduce((sum, entry) => sum + entry.basisPoints, 0) !== 10_000) throw new CommercialOperationsError("VALIDATION_FAILED", "allocation rule must allocate exactly 100 percent");
    const state: JsonObject = {
      ruleId: identifier(input.ruleId, "ruleId"), version: identifier(input.version, "version"), category: identifier(input.category, "category"),
      dimensions, allocations, effectiveFrom: dateOnly(input.effectiveFrom, "effectiveFrom"), status: "approved",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B93.configureAllocationRule", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finops.allocationRule", aggregateId: `${input.ruleId}:${input.version}`, expectedVersion: null,
        state, eventType: "finops.allocationRuleApproved", event: { category: input.category, dimensions, allocations },
      }).state,
    }).value as JsonObject;
  }

  allocateCost(actor: CommercialActor, costEventId: string, ruleId: string, ruleVersion: string, idempotencyKey: string): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const cost = this.#required<JsonObject>(actor.tenantId, "finops.costEvent", costEventId);
    requireState(cost.state.allocated === false, "cost event cannot be allocated twice");
    const rule = this.#required<JsonObject>(actor.tenantId, "finops.allocationRule", `${ruleId}:${ruleVersion}`).state;
    if (rule.category !== cost.state.category) throw new CommercialOperationsError("POLICY_BLOCKED", "allocation rule category does not match cost fact");
    const entries = rule.allocations as unknown as Array<Record<string, JsonValue>>;
    let allocated = 0;
    const allocations = entries.map((entry, index) => {
      const amount = index === entries.length - 1
        ? Number(cost.state.amountMinor) - allocated
        : Math.floor(Number(cost.state.amountMinor) * Number(entry.basisPoints) / 10_000);
      allocated += amount;
      return { target: entry.target, amountMinor: amount, ruleVersion };
    });
    const next = { ...cost.state, allocated: true, allocationRuleId: ruleId, allocationRuleVersion: ruleVersion, allocations };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey, operation: "B93.allocateCost", request: { costEventId, ruleId, ruleVersion },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finops.costEvent", aggregateId: cost.aggregateId, expectedVersion: cost.version,
        state: next, eventType: "finops.costAllocated", event: { ruleId, ruleVersion, allocations },
      }).state,
    }).value as JsonObject;
  }

  evaluateBudget(actor: CommercialActor, input: {
    readonly budgetId: string;
    readonly period: string;
    readonly limitMinor: number;
    readonly actualMinor: number;
    readonly projectedMinor: number;
    readonly action: "warn" | "throttle_unpaid" | "degrade_non_safety" | "manual_approval" | "disable_safety" | "cancel_paid";
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    if (input.action === "disable_safety" || input.action === "cancel_paid") throw new CommercialOperationsError("POLICY_BLOCKED", "budget actions cannot disable safety or cancel paid work");
    const state: JsonObject = {
      budgetId: identifier(input.budgetId, "budgetId"), period: validPeriod(input.period), limitMinor: minor(input.limitMinor),
      actualMinor: minor(input.actualMinor, "actualMinor", true), projectedMinor: minor(input.projectedMinor, "projectedMinor", true),
      breach: input.actualMinor > input.limitMinor || input.projectedMinor > input.limitMinor, action: input.action,
      safetyControlsPreserved: true, paidTasksProtected: true,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B93.evaluateBudget", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finops.budget", aggregateId: input.budgetId,
        expectedVersion: this.#repository.get(actor.tenantId, "finops.budget", input.budgetId)?.version ?? null,
        state, eventType: state.breach === true ? "finops.budgetBreached" : "finops.budgetWithinLimit", event: { period: input.period, action: input.action, breach: state.breach },
      }).state,
    }).value as JsonObject;
  }

  profitability(input: {
    readonly recognizedRevenueMinor: number;
    readonly refundsMinor: number;
    readonly partnerShareMinor: number;
    readonly acquisitionMinor: number;
    readonly serviceMinor: number;
    readonly fulfillmentMinor: number;
    readonly cashCollectedMinor: number;
  }): JsonObject {
    const values = {
      recognizedRevenueMinor: minor(input.recognizedRevenueMinor, "recognizedRevenueMinor", true),
      refundsMinor: minor(input.refundsMinor, "refundsMinor", true),
      partnerShareMinor: minor(input.partnerShareMinor, "partnerShareMinor", true),
      acquisitionMinor: minor(input.acquisitionMinor, "acquisitionMinor", true),
      serviceMinor: minor(input.serviceMinor, "serviceMinor", true),
      fulfillmentMinor: minor(input.fulfillmentMinor, "fulfillmentMinor", true),
      cashCollectedMinor: minor(input.cashCollectedMinor, "cashCollectedMinor", true),
    };
    const profit = values.recognizedRevenueMinor - values.refundsMinor - values.partnerShareMinor - values.acquisitionMinor - values.serviceMinor - values.fulfillmentMinor;
    return freeze({ ...values, profitMinor: profit, basis: "recognized_revenue_less_complete_costs", cashCollectedExcludedFromProfit: true });
  }

  forecastCost(actor: CommercialActor, input: {
    readonly forecastId: string;
    readonly budgetMinor: number;
    readonly forecastMinor: number;
    readonly assumptions: readonly string[];
    readonly confidenceBasisPoints: number;
    readonly sensitivityBasisPoints: number;
    readonly rootCauseCodes: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const state: JsonObject = {
      forecastId: identifier(input.forecastId, "forecastId"), budgetMinor: minor(input.budgetMinor), forecastMinor: minor(input.forecastMinor),
      assumptions: sortedUnique(input.assumptions, "assumptions"), confidenceBasisPoints: basisPoints(input.confidenceBasisPoints, "confidenceBasisPoints"),
      sensitivityBasisPoints: basisPoints(input.sensitivityBasisPoints, "sensitivityBasisPoints"), rootCauseCodes: sortedUnique(input.rootCauseCodes, "rootCauseCodes"),
      varianceMinor: input.forecastMinor - input.budgetMinor, estimateClearlyLabeled: true,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B93.forecastCost", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finops.forecast", aggregateId: input.forecastId, expectedVersion: null,
        state, eventType: "finops.forecastRecorded", event: { varianceMinor: state.varianceMinor, confidenceBasisPoints: state.confidenceBasisPoints },
      }).state,
    }).value as JsonObject;
  }

  // B94 — controlled close, immutable exports and signed ERP acknowledgement.
  createCloseChecklist(actor: CommercialActor, input: {
    readonly closeId: string;
    readonly legalEntityId: string;
    readonly currency: string;
    readonly period: string;
    readonly tasks: readonly { readonly taskId: string; readonly domain: "payment" | "bank" | "partner" | "vendor" | "deferred" | "revenue" | "tax" | "dispute" | "reserve" | "fx" | "exception"; readonly ownerId: string; readonly dependencyTaskIds: readonly string[]; readonly status: "complete" | "blocked"; readonly evidenceSha256: string }[];
    readonly materialityMinor: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const tasks = input.tasks.map((task) => {
      if (!/^[a-f0-9]{64}$/.test(task.evidenceSha256)) throw new CommercialOperationsError("VALIDATION_FAILED", "close task evidence digest is invalid");
      return { taskId: identifier(task.taskId, "taskId"), domain: task.domain, ownerId: identifier(task.ownerId, "ownerId"), dependencyTaskIds: sortedUnique(task.dependencyTaskIds, "dependencyTaskIds", 0), status: task.status, evidenceSha256: task.evidenceSha256 };
    });
    const requiredDomains = new Set(["payment", "bank", "partner", "vendor", "deferred", "revenue", "tax", "dispute", "reserve", "fx", "exception"]);
    if (new Set(tasks.map((task) => task.domain)).size !== requiredDomains.size || tasks.some((task) => !requiredDomains.has(task.domain))) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "month-close checklist must cover every required finance domain exactly once");
    }
    const taskIds = new Set(tasks.map((task) => task.taskId));
    if (taskIds.size !== tasks.length || tasks.some((task) => task.dependencyTaskIds.some((dependency) => !taskIds.has(dependency) || dependency === task.taskId))) {
      throw new CommercialOperationsError("VALIDATION_FAILED", "month-close task identities/dependencies are invalid");
    }
    const pending = new Map(tasks.map((task) => [task.taskId, [...task.dependencyTaskIds]]));
    while (pending.size > 0) {
      const ready = [...pending.entries()].filter(([, dependencies]) => dependencies.every((dependency) => !pending.has(dependency)));
      if (ready.length === 0) throw new CommercialOperationsError("VALIDATION_FAILED", "month-close task dependencies contain a cycle");
      for (const [taskId] of ready) pending.delete(taskId);
    }
    const state: JsonObject = {
      closeId: identifier(input.closeId, "closeId"), legalEntityId: identifier(input.legalEntityId, "legalEntityId"),
      currency: currency(input.currency), period: validPeriod(input.period), tasks, materialityMinor: minor(input.materialityMinor, "materialityMinor", true),
      state: tasks.every((task) => task.status === "complete") ? "ready" : "blocked", approvals: [], exports: [], auditPackageDigest: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B94.createCloseChecklist", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finance.close", aggregateId: input.closeId, expectedVersion: null,
        state, eventType: "finance.closeChecklistCreated", event: { period: input.period, taskCount: tasks.length, ready: state.state === "ready" },
      }).state,
    }).value as JsonObject;
  }

  hardClose(actor: CommercialActor, input: {
    readonly closeId: string;
    readonly approverIds: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES, input.approverIds);
    const close = this.#required<JsonObject>(actor.tenantId, "finance.close", input.closeId);
    requireState(close.state.state === "ready" || close.state.state === "soft_closed", "month close has blocked or incomplete tasks");
    const approvals = sortedUnique(input.approverIds, "approverIds", 2);
    const checklistDigest = sha256(canonicalJson({ tasks: close.state.tasks, materialityMinor: close.state.materialityMinor }));
    const state = { ...close.state, state: "hard_closed", approvals, checklistDigest };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B94.hardClose", request: { closeId: input.closeId, approverIds: approvals, checklistDigest },
      run: () => {
        const periodId = `${String(close.state.legalEntityId)}:${String(close.state.period)}`;
        const period = this.#repository.get<PeriodState>(actor.tenantId, "finance.period", periodId);
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "finance.period", aggregateId: periodId, expectedVersion: period?.version ?? null,
          state: { period: close.state.period, legalEntityId: close.state.legalEntityId, state: "hard_closed", approvals, checklistDigest, reopenedAt: null },
          eventType: "finance.period.hard_closed", event: { closeId: input.closeId, approvals, checklistDigest },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "finance.close", aggregateId: close.aggregateId, expectedVersion: close.version,
          state, eventType: "finance.monthHardClosed", event: { approvals, checklistDigest },
        }).state;
      },
    }).value as JsonObject;
  }

  reopenPeriod(actor: CommercialActor, input: {
    readonly closeId: string;
    readonly approverIds: readonly string[];
    readonly adjustmentPeriod: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES, input.approverIds);
    const close = this.#required<JsonObject>(actor.tenantId, "finance.close", input.closeId);
    requireState(close.state.state === "hard_closed", "only a hard-closed period can be formally reopened");
    const adjustmentPeriod = validPeriod(input.adjustmentPeriod);
    if (adjustmentPeriod <= String(close.state.period)) throw new CommercialOperationsError("PERIOD_LOCKED", "reopen must post into a later adjustment period");
    const approvals = sortedUnique(input.approverIds, "approverIds", 2);
    const state = { ...close.state, state: "reopened_for_adjustment", reopen: { approvals, adjustmentPeriod, reason: nonEmpty(input.reason, "reason"), reopenedAt: this.#clock().toISOString() } };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B94.reopenPeriod", request: { closeId: input.closeId, approvals, adjustmentPeriod, reason: input.reason },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finance.close", aggregateId: close.aggregateId, expectedVersion: close.version,
        state, eventType: "finance.periodReopenedForAdjustment", event: state.reopen as JsonObject,
      }).state,
    }).value as JsonObject;
  }

  createAccountingExport(actor: CommercialActor, input: {
    readonly exportId: string;
    readonly closeId: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly encryptionKeyReference: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, REVIEW_ROLES);
    const close = this.#required<JsonObject>(actor.tenantId, "finance.close", input.closeId);
    requireState(close.state.state === "hard_closed" || close.state.state === "reopened_for_adjustment", "accounting export requires controlled period state");
    if (!input.encryptionKeyReference.startsWith("kms:")) throw new CommercialOperationsError("CONFIGURATION_INVALID", "accounting export requires managed KMS encryption reference");
    const balance = this.trialBalance(actor.tenantId, String(close.state.legalEntityId), currency(String(close.state.currency)), String(close.state.period));
    const journalEvents = this.#repository.listEvents(actor.tenantId, "finance.journal").filter((event) => (event.payload as JsonObject).period === close.state.period);
    const control = {
      rowCount: journalEvents.length,
      debitMinor: balance.debitMinor,
      creditMinor: balance.creditMinor,
      sourceDigest: sha256(canonicalJson(journalEvents.map((event) => event.payload))),
    };
    if (control.debitMinor !== control.creditMinor) conflict("accounting export control totals do not balance");
    const state: JsonObject = {
      exportId: identifier(input.exportId, "exportId"), closeId: input.closeId, adapterId: identifier(input.adapterId, "adapterId"),
      adapterVersion: identifier(input.adapterVersion, "adapterVersion"), encryptionKeyReference: input.encryptionKeyReference,
      control, exportSha256: sha256(canonicalJson({ closeId: input.closeId, adapterId: input.adapterId, adapterVersion: input.adapterVersion, control })),
      state: "awaiting_transport_confirmation", transportFactId: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B94.createAccountingExport", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finance.accountingExport", aggregateId: input.exportId, expectedVersion: null,
        state, eventType: "finance.accountingExportCreated", event: { exportSha256: state.exportSha256, control },
      }).state,
    }).value as JsonObject;
  }

  acknowledgeAccountingExport(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, FINANCE_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "accounting.export-ack");
    const exported = this.#required<JsonObject>(actor.tenantId, "finance.accountingExport", verified.subjectId);
    assertExactKeys(verified.payload, ["exportId", "exportSha256", "status", "providerBatchId"], "accounting export acknowledgement");
    if (verified.payload.exportId !== exported.aggregateId || verified.payload.exportSha256 !== exported.state.exportSha256 || verified.payload.status !== "accepted") {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "accounting system acknowledgement does not match the exact export");
    }
    return this.#atomicFact(actor, verified, idempotencyKey, "B94.acknowledgeAccountingExport", { exportId: exported.aggregateId, exportSha256: exported.state.exportSha256 }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finance.accountingExport", aggregateId: exported.aggregateId, expectedVersion: exported.version,
        state: { ...exported.state, state: "accepted", transportFactId: verified.factId, providerBatchId: verified.payload.providerBatchId },
        eventType: "finance.accountingExportAccepted", event: { factId: verified.factId, providerBatchId: verified.payload.providerBatchId },
      }).state);
  }

  createAuditPackage(actor: CommercialActor, input: {
    readonly closeId: string;
    readonly policyVersions: readonly string[];
    readonly accessLogSha256: string;
    readonly changeLogSha256: string;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, ["auditor", "finance_admin", "platform_admin"]);
    const close = this.#required<JsonObject>(actor.tenantId, "finance.close", input.closeId);
    if (![input.accessLogSha256, input.changeLogSha256].every((digest) => /^[a-f0-9]{64}$/.test(digest))) throw new CommercialOperationsError("VALIDATION_FAILED", "audit evidence digest is invalid");
    const exports = this.#repository.listEvents(actor.tenantId, "finance.accountingExport").map((event) => event.payload);
    const packageProjection: JsonObject = {
      closeId: input.closeId, period: close.state.period, legalEntityId: close.state.legalEntityId,
      policyVersions: sortedUnique(input.policyVersions, "policyVersions"), approvals: close.state.approvals,
      journalSourceDigest: sha256(canonicalJson(this.#repository.listEvents(actor.tenantId, "finance.journal").map((event) => event.payload))),
      reconciliationEvidenceDigest: sha256(canonicalJson(this.#repository.listEvents(actor.tenantId, "finance.reconciliationWindow").map((event) => event.payload))),
      exportEvidenceDigest: sha256(canonicalJson(exports)), accessLogSha256: input.accessLogSha256, changeLogSha256: input.changeLogSha256,
      expiresAt: exactUtc(input.expiresAt, "expiresAt"), watermark: `${actor.actorId}:${input.closeId}`, sensitiveFieldsMinimized: true,
    };
    const state = { ...packageProjection, auditPackageSha256: sha256(canonicalJson(packageProjection)) };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B94.createAuditPackage", request: packageProjection,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "finance.auditPackage", aggregateId: input.closeId, expectedVersion: null,
        state, eventType: "finance.auditPackageCreated", event: { auditPackageSha256: state.auditPackageSha256, expiresAt: input.expiresAt, watermark: packageProjection.watermark },
      }).state,
    }).value as JsonObject;
  }

  #verifyFact(fact: SignedCommercialFact, tenantId: string, factKind: string, subjectId?: string): VerifiedCommercialFact {
    return this.#facts.verify(fact, { tenantId, factKind, ...(subjectId === undefined ? {} : { subjectId }) });
  }

  #atomicFact(
    actor: CommercialActor,
    fact: VerifiedCommercialFact,
    idempotencyKey: string,
    operation: string,
    request: JsonObject,
    run: () => JsonObject,
  ): JsonObject {
    return this.#repository.execute({
      tenantId: actor.tenantId,
      idempotencyKey,
      operation,
      request: { ...request, factId: fact.factId, factSha256: fact.factSha256 },
      run: () => {
        this.#repository.claimExternalFact({
          tenantId: actor.tenantId, factId: fact.factId, factSha256: fact.factSha256, provider: fact.provider,
          factKind: fact.factKind, subjectId: fact.subjectId, sequence: fact.sequence, occurredAt: fact.occurredAt,
        });
        return run();
      },
    }).value as JsonObject;
  }

  #required<T extends JsonObject>(tenantId: string, aggregateType: string, aggregateId: string): AggregateSnapshot<T> {
    const value = this.#repository.get<T>(tenantId, aggregateType, aggregateId);
    if (value === undefined) throw new CommercialOperationsError("NOT_FOUND", `${aggregateType} ${aggregateId} was not found`);
    return value;
  }

  #period(tenantId: string, legalEntityId: string, period: string): AggregateSnapshot<PeriodState> {
    const existing = this.#repository.get<PeriodState>(tenantId, "finance.period", `${legalEntityId}:${period}`);
    if (existing !== undefined) return existing;
    return freeze({
      aggregateType: "finance.period",
      aggregateId: `${legalEntityId}:${period}`,
      version: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
      state: { period, legalEntityId, state: "open", approvals: [], checklistDigest: null, reopenedAt: null },
    });
  }

  #assertSourceReferenceUnused(tenantId: string, legalEntityId: string, sourceReference: string): void {
    const used = this.#repository.listEvents(tenantId, "finance.journal").some((event) => {
      const payload = event.payload as unknown as JournalEntryState;
      return payload.legalEntityId === legalEntityId && payload.sourceReference === sourceReference;
    });
    if (used) conflict("external transaction or business-event source reference was already posted");
  }
}

function validateAccount(account: AccountDefinition): AccountDefinition {
  return freeze({
    code: identifier(account.code, "account code", 64),
    name: nonEmpty(account.name, "account name", 160),
    class: account.class,
    normalSide: account.normalSide,
  });
}

function validatePostingRule(rule: PostingRule, accountCodes: ReadonlySet<string>): PostingRule {
  if (!POSTING_KINDS.includes(rule.eventKind) || !accountCodes.has(rule.debitAccount) || !accountCodes.has(rule.creditAccount) || rule.debitAccount === rule.creditAccount) {
    throw new CommercialOperationsError("VALIDATION_FAILED", "posting rule accounts or event kind are invalid");
  }
  const effectiveFrom = exactUtc(rule.effectiveFrom, "posting rule effectiveFrom");
  const effectiveUntil = rule.effectiveUntil === null ? null : exactUtc(rule.effectiveUntil, "posting rule effectiveUntil");
  if (effectiveUntil !== null && effectiveUntil < effectiveFrom) throw new CommercialOperationsError("VALIDATION_FAILED", "posting rule effective range is invalid");
  return freeze({
    eventKind: rule.eventKind,
    version: identifier(rule.version, "posting rule version"),
    debitAccount: identifier(rule.debitAccount, "debit account"),
    creditAccount: identifier(rule.creditAccount, "credit account"),
    effectiveFrom,
    effectiveUntil,
  });
}

function assertBalanced(lines: readonly JournalLine[]): void {
  if (lines.length < 2) throw new CommercialOperationsError("VALIDATION_FAILED", "journal entry requires at least two lines");
  const currencies = new Set(lines.map((line) => currency(line.currency)));
  if (currencies.size !== 1) throw new CommercialOperationsError("VALIDATION_FAILED", "journal entry cannot implicitly convert currency");
  const debit = lines.reduce((sum, line) => sum + minor(line.debitMinor, "debitMinor", true), 0);
  const credit = lines.reduce((sum, line) => sum + minor(line.creditMinor, "creditMinor", true), 0);
  if (debit < 1 || debit !== credit) throw new CommercialOperationsError("VALIDATION_FAILED", "journal entry debits and credits must balance exactly");
}

function validateStatementLine(value: JsonValue, index: number): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", `statement line ${index} is invalid`);
  const line = value as unknown as Readonly<Record<string, unknown>>;
  assertExactKeys(line, ["providerTransactionId", "orderId", "grossMinor", "feeMinor", "refundMinor", "netMinor", "occurredAt"], "payment statement line");
  const gross = minor(Number(line.grossMinor), "grossMinor", true);
  const fee = minor(Number(line.feeMinor), "feeMinor", true);
  const refund = minor(Number(line.refundMinor), "refundMinor", true);
  const net = signedMinor(Number(line.netMinor), "netMinor");
  if (gross - fee - refund !== net) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "payment statement line control total is invalid");
  return freeze({
    providerTransactionId: identifier(String(line.providerTransactionId), "providerTransactionId"),
    orderId: identifier(String(line.orderId), "orderId"), grossMinor: gross, feeMinor: fee, refundMinor: refund, netMinor: net,
    occurredAt: exactUtc(String(line.occurredAt), "occurredAt"),
  });
}

function validPeriod(value: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) throw new CommercialOperationsError("VALIDATION_FAILED", "accounting period must be YYYY-MM");
  return value;
}
