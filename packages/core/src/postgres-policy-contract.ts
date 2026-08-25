/**
 * The complete tenant-owned PostgreSQL surface for runtime schema version 5.
 * Keep this closed set aligned with the checksum-bound migrations.
 */
export const POSTGRES_TENANT_TABLES = [
  "records",
  "consents",
  "idempotency",
  "inbox",
  "outbox",
  "audit_log",
  "ledger_transactions",
  "ledger_lines",
  "external_evidence",
  "evidence_consumptions",
  "external_commands",
  "external_command_transitions",
  "evidence_decisions",
  "external_business_events",
  "participants",
  "guardian_authorizations",
  "authorized_agent_authorizations",
] as const;

export interface PostgresPolicyCatalogRow {
  readonly tablename: unknown;
  readonly policyname: unknown;
  readonly command: unknown;
  readonly permissive: unknown;
  /** pg_policy.polroles is exactly ARRAY[0::oid], PostgreSQL's PUBLIC sentinel. */
  readonly public_only: unknown;
  readonly using_expression: unknown;
  readonly check_expression: unknown;
}

const TENANT_EXPRESSION = "(tenant_id=ltm.current_tenant())";

/**
 * pg_get_expr is PostgreSQL's canonical deparser. Ignore only formatting
 * whitespace and whitelist the one accepted expression; do not attempt to
 * simplify arbitrary SQL, since doing so could broaden a policy by mistake.
 */
export function isExactTenantIsolationExpression(value: unknown): boolean {
  return typeof value === "string" &&
    value.replace(/[\t\n\f\r ]+/gu, "") === TENANT_EXPRESSION;
}

/**
 * Accept exactly one all-command, permissive, PUBLIC policy for every tenant
 * table. Query callers must pass every pg_policy row for the closed table set,
 * including policies with names other than tenant_isolation, so extras fail.
 */
export function hasExactTenantIsolationPolicySet(
  rows: readonly PostgresPolicyCatalogRow[],
  expectedTables: readonly string[] = POSTGRES_TENANT_TABLES,
): boolean {
  if (rows.length !== expectedTables.length || new Set(expectedTables).size !== expectedTables.length) {
    return false;
  }
  const missing = new Set(expectedTables);
  for (const row of rows) {
    if (typeof row.tablename !== "string" || !missing.delete(row.tablename) ||
        row.policyname !== "tenant_isolation" || row.command !== "*" ||
        row.permissive !== true || row.public_only !== true ||
        !isExactTenantIsolationExpression(row.using_expression) ||
        !isExactTenantIsolationExpression(row.check_expression)) {
      return false;
    }
  }
  return missing.size === 0;
}
