import { POSTGRES_TENANT_TABLES } from "./postgres-policy-contract.js";

/** Schema-6/7 tenant and partner projections covered by the data contract. */
export const POSTGRES_DATA_TENANT_TABLES = Object.freeze([
  ...POSTGRES_TENANT_TABLES,
  "data_tracking_queue", "data_warehouse_state", "commerce_finance_state",
  "growth_operations_state", "partner_settlement_state", "referral_rewards",
  "lifecycle_deliveries", "partner_usage_events", "partner_rate_contracts",
  "partner_settlement_statements", "partner_anomaly_decisions",
] as const);

export type DataClassification = "internal" | "confidential" | "restricted";
export type EncryptionControl = "deployment_at_rest_and_tls" | "application_digest_and_deployment_encryption";

export interface DataFieldPolicy {
  readonly field: string;
  readonly classification: DataClassification;
  readonly retentionPolicy: string;
  readonly encryptionControl: EncryptionControl;
  readonly allowedPurposes: readonly string[];
}

export interface DataTablePolicy {
  readonly table: string;
  readonly tenantScoped: boolean;
  readonly scopeField?: "tenant_id" | "partner_id";
  readonly deletionSemantics: "mutable_lifecycle" | "append_only" | "schema_controlled";
  readonly fields: readonly DataFieldPolicy[];
}

type FieldInput = readonly [
  field: string,
  classification: DataClassification,
  retentionPolicy: string,
  encryptionControl: EncryptionControl,
  allowedPurposes: readonly string[],
];

const encrypted: EncryptionControl = "deployment_at_rest_and_tls";
const digestProtected: EncryptionControl = "application_digest_and_deployment_encryption";

function tenantTable(
  table: string,
  deletionSemantics: DataTablePolicy["deletionSemantics"],
  inputs: readonly FieldInput[],
): DataTablePolicy {
  return Object.freeze({
    table,
    tenantScoped: true,
    deletionSemantics,
    fields: Object.freeze([
      field("tenant_id", "internal", "tenant_lifecycle", encrypted, ["tenant_isolation"]),
      ...inputs.map((input) => field(...input)),
    ]),
  });
}

function partnerTable(table: string, deletionSemantics: DataTablePolicy["deletionSemantics"], inputs: readonly FieldInput[]): DataTablePolicy {
  return Object.freeze({ table, tenantScoped: true, scopeField: "partner_id" as const, deletionSemantics, fields: Object.freeze([field("partner_id", "internal", "tenant_lifecycle", encrypted, ["tenant_isolation"]), ...inputs.map((input) => field(...input))]) });
}

function field(
  name: string,
  classification: DataClassification,
  retentionPolicy: string,
  encryptionControl: EncryptionControl,
  allowedPurposes: readonly string[],
): DataFieldPolicy {
  return Object.freeze({
    field: name,
    classification,
    retentionPolicy,
    encryptionControl,
    allowedPurposes: Object.freeze([...allowedPurposes]),
  });
}

/**
 * Closed, executable schema-v7 data policy catalog. Generic JSON columns are
 * classified at their highest permitted sensitivity so adding a new payload
 * field never silently lowers the storage control.
 */
export const DATA_DICTIONARY: readonly DataTablePolicy[] = Object.freeze([
  tenantTable("records", "mutable_lifecycle", [
    ["owner_actor_id", "confidential", "record_lifecycle", encrypted, ["capability_execution", "rights_fulfillment"]],
    ["participant_ids", "restricted", "record_lifecycle", encrypted, ["consent_enforcement", "rights_fulfillment"]],
    ["data", "restricted", "record_lifecycle", encrypted, ["capability_execution", "rights_fulfillment"]],
    ["deleted_at", "confidential", "deletion_evidence_window", encrypted, ["deletion_verification", "audit"]],
  ]),
  tenantTable("consents", "mutable_lifecycle", [
    ["participant_id", "restricted", "consent_legal_basis", encrypted, ["consent_enforcement", "rights_fulfillment"]],
    ["grantor_actor_id", "restricted", "consent_legal_basis", encrypted, ["consent_enforcement", "audit"]],
    ["scope", "confidential", "consent_legal_basis", encrypted, ["consent_enforcement", "rights_fulfillment"]],
    ["evidence_hash", "confidential", "consent_legal_basis", digestProtected, ["consent_verification", "audit"]],
  ]),
  tenantTable("idempotency", "mutable_lifecycle", [
    ["actor_id", "confidential", "idempotency_window", encrypted, ["request_deduplication", "incident_investigation"]],
    ["request_fingerprint", "confidential", "idempotency_window", digestProtected, ["request_deduplication"]],
    ["response_json", "restricted", "idempotency_window", encrypted, ["request_deduplication"]],
  ]),
  tenantTable("inbox", "mutable_lifecycle", [
    ["source_event_id", "confidential", "operational_event_window", encrypted, ["event_deduplication", "incident_investigation"]],
    ["payload", "restricted", "operational_event_window", encrypted, ["event_processing", "incident_investigation"]],
    ["request_fingerprint", "confidential", "operational_event_window", digestProtected, ["event_deduplication"]],
  ]),
  tenantTable("outbox", "mutable_lifecycle", [
    ["aggregate_id", "confidential", "operational_event_window", encrypted, ["event_delivery", "incident_investigation"]],
    ["payload", "restricted", "operational_event_window", encrypted, ["event_delivery"]],
    ["last_error", "confidential", "operational_event_window", encrypted, ["incident_investigation"]],
  ]),
  tenantTable("audit_log", "append_only", [
    ["actor_id", "restricted", "audit_legal_hold", encrypted, ["security_audit", "rights_fulfillment"]],
    ["resource_id", "confidential", "audit_legal_hold", encrypted, ["security_audit", "incident_investigation"]],
    ["details", "restricted", "audit_legal_hold", encrypted, ["security_audit", "incident_investigation"]],
    ["hash", "confidential", "audit_legal_hold", digestProtected, ["audit_integrity"]],
  ]),
  tenantTable("ledger_transactions", "append_only", [
    ["source_id", "confidential", "financial_record_policy", encrypted, ["accounting", "reconciliation", "audit"]],
    ["description", "confidential", "financial_record_policy", encrypted, ["accounting", "audit"]],
    ["request_fingerprint", "confidential", "financial_record_policy", digestProtected, ["accounting_integrity"]],
  ]),
  tenantTable("ledger_lines", "append_only", [
    ["amount_minor", "confidential", "financial_record_policy", encrypted, ["accounting", "reconciliation", "audit"]],
    ["memo", "confidential", "financial_record_policy", encrypted, ["accounting", "audit"]],
  ]),
  tenantTable("external_evidence", "append_only", [
    ["subject_json", "restricted", "evidence_contract", encrypted, ["evidence_verification", "release_assurance"]],
    ["artifact_sha256", "confidential", "evidence_contract", digestProtected, ["evidence_verification"]],
    ["signature", "confidential", "evidence_contract", digestProtected, ["evidence_verification"]],
  ]),
  tenantTable("evidence_consumptions", "append_only", [
    ["evidence_id", "confidential", "evidence_contract", encrypted, ["evidence_verification", "audit"]],
    ["mutation_fingerprint", "confidential", "evidence_contract", digestProtected, ["evidence_verification"]],
  ]),
  tenantTable("external_commands", "mutable_lifecycle", [
    ["aggregate_id", "confidential", "workflow_history", encrypted, ["external_delivery", "compensation", "audit"]],
    ["request_payload", "restricted", "workflow_history", encrypted, ["external_delivery", "compensation"]],
    ["provider_operation_id", "confidential", "workflow_history", encrypted, ["external_delivery", "reconciliation"]],
  ]),
  tenantTable("external_command_transitions", "append_only", [
    ["details", "restricted", "workflow_history", encrypted, ["workflow_replay", "compensation", "audit"]],
    ["transition_fingerprint", "confidential", "workflow_history", digestProtected, ["workflow_integrity"]],
  ]),
  tenantTable("evidence_decisions", "append_only", [
    ["subject_json", "restricted", "evidence_contract", encrypted, ["evidence_verification", "audit"]],
    ["decision_fingerprint", "confidential", "evidence_contract", digestProtected, ["evidence_verification"]],
  ]),
  tenantTable("external_business_events", "append_only", [
    ["raw_artifact_sha256", "confidential", "evidence_contract", digestProtected, ["provider_event_verification", "audit"]],
    ["business_event_json", "restricted", "evidence_contract", encrypted, ["provider_event_application", "reconciliation"]],
  ]),
  tenantTable("participants", "mutable_lifecycle", [
    ["participant_id", "restricted", "participant_authority", encrypted, ["consent_enforcement", "rights_fulfillment"]],
    ["owner_actor_id", "restricted", "participant_authority", encrypted, ["consent_enforcement", "rights_fulfillment"]],
    ["minor_status", "restricted", "participant_authority", encrypted, ["guardian_safety", "consent_enforcement"]],
  ]),
  tenantTable("guardian_authorizations", "mutable_lifecycle", [
    ["guardian_actor_id", "restricted", "participant_authority", encrypted, ["guardian_safety", "consent_enforcement"]],
    ["participant_id", "restricted", "participant_authority", encrypted, ["guardian_safety", "rights_fulfillment"]],
    ["scope", "confidential", "participant_authority", encrypted, ["consent_enforcement"]],
  ]),
  tenantTable("authorized_agent_authorizations", "mutable_lifecycle", [
    ["authorized_actor_id", "restricted", "participant_authority", encrypted, ["delegated_authority", "consent_enforcement"]],
    ["participant_id", "restricted", "participant_authority", encrypted, ["delegated_authority", "rights_fulfillment"]],
    ["scope", "confidential", "participant_authority", encrypted, ["consent_enforcement"]],
  ]),
  tenantTable("data_tracking_queue", "mutable_lifecycle", [
    ["event_id", "confidential", "operational_event_window", encrypted, ["event_processing"]],
    ["envelope", "restricted", "operational_event_window", encrypted, ["event_processing", "audit"]],
    ["state", "internal", "operational_event_window", encrypted, ["event_processing"]],
  ]),
  tenantTable("data_warehouse_state", "mutable_lifecycle", [
    ["state_key", "internal", "analytics_lifecycle", encrypted, ["analytics"]],
    ["snapshot", "restricted", "analytics_lifecycle", encrypted, ["analytics", "audit"]],
  ]),
  tenantTable("commerce_finance_state", "mutable_lifecycle", [
    ["version", "internal", "financial_record_policy", encrypted, ["accounting_integrity"]],
    ["state", "restricted", "financial_record_policy", encrypted, ["accounting", "reconciliation"]],
  ]),
  tenantTable("growth_operations_state", "mutable_lifecycle", [
    ["version", "internal", "growth_lifecycle", encrypted, ["growth_analytics"]],
    ["state", "restricted", "growth_lifecycle", encrypted, ["growth_analytics", "audit"]],
  ]),
  partnerTable("partner_settlement_state", "mutable_lifecycle", [["version", "internal", "settlement_lifecycle", encrypted, ["settlement"]], ["state", "restricted", "settlement_lifecycle", encrypted, ["settlement", "audit"]]]),
  tenantTable("referral_rewards", "append_only", [["id", "confidential", "financial_record_policy", encrypted, ["settlement", "audit"]], ["source_key", "confidential", "financial_record_policy", digestProtected, ["settlement_integrity"]], ["amount_minor", "confidential", "financial_record_policy", encrypted, ["settlement"]]]),
  tenantTable("lifecycle_deliveries", "append_only", [["message_id", "confidential", "notification_lifecycle", encrypted, ["notification_delivery"]], ["account_id", "restricted", "notification_lifecycle", encrypted, ["notification_delivery"]]]),
  partnerTable("partner_usage_events", "append_only", [["id", "confidential", "settlement_lifecycle", encrypted, ["settlement"]], ["payload", "restricted", "settlement_lifecycle", encrypted, ["settlement", "audit"]]]),
  partnerTable("partner_rate_contracts", "mutable_lifecycle", [["contract_id", "confidential", "contract_lifetime", encrypted, ["settlement"]], ["payload", "restricted", "contract_lifetime", encrypted, ["settlement", "audit"]]]),
  partnerTable("partner_settlement_statements", "mutable_lifecycle", [["id", "confidential", "financial_record_policy", encrypted, ["settlement", "audit"]], ["amount_minor", "confidential", "financial_record_policy", encrypted, ["settlement"]], ["artifact_sha256", "confidential", "financial_record_policy", digestProtected, ["settlement_integrity"]]]),
  partnerTable("partner_anomaly_decisions", "append_only", [["statement_id", "confidential", "settlement_lifecycle", encrypted, ["settlement"]], ["evidence_sha256", "confidential", "settlement_lifecycle", digestProtected, ["settlement_integrity"]]]),
  Object.freeze({
    table: "schema_metadata",
    tenantScoped: false,
    deletionSemantics: "schema_controlled",
    fields: Object.freeze([
      field("key", "internal", "schema_lifetime", encrypted, ["schema_compatibility"]),
      field("value", "internal", "schema_lifetime", encrypted, ["schema_compatibility"]),
    ]),
  }),
]);

export function validateDataDictionary(
  dictionary: readonly DataTablePolicy[] = DATA_DICTIONARY,
): { readonly tableCount: number; readonly fieldCount: number } {
  const expected = new Set<string>([...POSTGRES_DATA_TENANT_TABLES, "schema_metadata"]);
  const seen = new Set<string>();
  let fieldCount = 0;
  for (const table of dictionary) {
    if (!expected.delete(table.table) || !seen.add(table.table)) throw new Error(`Unknown or duplicate data table policy: ${table.table}`);
    if (table.tenantScoped !== (table.table !== "schema_metadata")) throw new Error(`Invalid tenant scope policy: ${table.table}`);
    const fields = new Set<string>();
    for (const policy of table.fields) {
      if (!/^[a-z][a-z0-9_]*$/.test(policy.field) || !fields.add(policy.field)) throw new Error(`Invalid or duplicate field policy: ${table.table}.${policy.field}`);
      if (policy.retentionPolicy.trim() === "" || policy.allowedPurposes.length === 0 ||
          policy.allowedPurposes.some((purpose) => purpose.trim() === "")) {
        throw new Error(`Incomplete data policy: ${table.table}.${policy.field}`);
      }
      fieldCount += 1;
    }
    if (table.tenantScoped && !fields.has(table.scopeField ?? "tenant_id")) throw new Error(`Missing tenant policy: ${table.table}`);
  }
  if (expected.size > 0) throw new Error(`Missing data table policies: ${[...expected].sort().join(",")}`);
  return Object.freeze({ tableCount: seen.size, fieldCount });
}
