#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  APPROVAL_AUTHORITY_ROLES,
  B127_PRODUCTION_RELEASE_AUTHORITY_ROLE,
  CHANGE_APPROVER_AUTHORITY_ROLES,
  CONTROL_ARTIFACT_AUTHORITY_ROLES,
  EvidenceContractError,
  REQUIRED_APPROVAL_NAMES,
  REQUIRED_SCHEMA7_FORCE_RLS_TABLES,
  REQUIRED_WORKLOAD_ROLES,
  SUPPLY_CHAIN_AUTHORITY_ROLE,
  productionReleaseSubjectSha256,
  validateReleaseApprovalArtifact,
  validateReleaseSbom,
  validateProductionReleaseSubject,
} from "./production-evidence-contracts.mjs";
import {
  B127ReleaseControlError,
  CONTROL_ARTIFACT_ATTESTATION_SCHEMA_VERSION,
  REQUIRED_B127_MONITORING_DOMAINS,
  controlArtifactAttestationScope,
  controlArtifactAttestationSigningBytes,
  validateRolloutGuardrailPolicy,
  validateRollbackForwardDrill,
  validateRolloutWaveObservation,
  waveObservationArtifactSetSha256,
} from "./b127-release-controls.mjs";
import { verifySupplyChainBundle } from "../security/supply-chain.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TRUST_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SBOM_BYTES = 100 * 1024 * 1024;
const MAX_APPROVAL_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_RELEASE_CONTROL_ARTIFACT_BYTES = 100 * 1024 * 1024;
const CHANGE_APPROVER_SCOPE_PREFIX = "ltm-change-approval:v1:";
const PRODUCTION_CHANGE_EXECUTOR_ROLE = "production-change-executor";
const GENERAL_GATEWAY_AUTHORITY_IDENTITY = /(?:^|[:._-])(?:integration[-_]?gateway|direct[-_]?evidence|supply[-_]?event|callback)(?:$|[:._-])/i;
const CONTROL_ARTIFACT_PROVIDER_PREFIXES = Object.freeze({
  monitoring_query: "monitoring-query",
  monitoring_result: "monitoring-result",
  pause_command: "rollout-controller",
  pause_receipt: "rollout-actuator",
});
const CONTROL_ARTIFACT_STATES = Object.freeze({
  monitoring_query: "query_defined",
  monitoring_result: "result_complete",
  pause_command: "pause_issued",
  pause_receipt: "pause_acknowledged",
});
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const EXPECTED_BATCH_IDS = Object.freeze(Array.from({ length: 128 }, (_, index) => `B${String(index).padStart(2, "0")}`));
const REQUIRED_COMPONENT_VERSIONS = Object.freeze([
  "api",
  "web",
  "sdkTypeScript",
  "sdkPython",
  "sdkJava",
  "mobileIos",
  "mobileAndroid",
  "wechatMiniProgram",
  "productionConfiguration",
]);
const REQUIRED_RELEASE_GATES = Object.freeze(Array.from({ length: 12 }, (_, index) => `G${index}`));
const REQUIRED_SCHEMA7_MIGRATIONS = Object.freeze([
  Object.freeze({ id: "001", path: "001_core.sql" }),
  Object.freeze({ id: "002", path: "002_external_evidence.sql" }),
  Object.freeze({ id: "003", path: "003_runtime_compatibility.sql" }),
  Object.freeze({ id: "004", path: "004_external_business_events.sql" }),
  Object.freeze({ id: "005", path: "005_participant_authority_and_processing_purpose.sql" }),
  Object.freeze({ id: "006", path: "006_data_intelligence_durability.sql" }),
  Object.freeze({ id: "007", path: "007_commerce_partner_growth.sql" }),
]);
const REQUIRED_APPROVALS = Object.freeze({
  independentPenetrationTest: "passed",
  legalRegulatoryReview: "approved",
  manualAccessibilityReview: "passed",
  appleAppStoreDecision: "approved",
  googlePlayDecision: "approved",
  wechatMiniProgramDecision: "approved",
  disasterRecoveryDrill: "passed",
  productionChangeApproval: "approved",
});
const B127_POSTGRES_TABLES = Object.freeze([
  "schema_metadata",
  "records",
  "external_evidence",
  "evidence_consumptions",
]);
const B127_POSTGRES_TENANT_TABLES = REQUIRED_SCHEMA7_FORCE_RLS_TABLES;
const B127_POSTGRES_COLUMNS = Object.freeze({
  schema_metadata: ["key:text:NO", "value:text:NO"],
  records: [
    "tenant_id:text:NO", "collection:text:NO", "id:text:NO", "data:jsonb:NO",
    "version:bigint:NO", "created_at:timestamp with time zone:NO",
    "updated_at:timestamp with time zone:NO", "deleted_at:timestamp with time zone:YES",
  ],
  external_evidence: [
    "tenant_id:text:NO", "id:text:NO", "envelope_version:text:NO", "issuer:text:NO",
    "provider:text:NO", "environment:text:NO", "scope:text:NO", "artifact_sha256:text:NO",
    "issued_at:timestamp with time zone:NO", "expires_at:timestamp with time zone:NO",
    "nonce:text:NO", "replay_policy:text:NO", "algorithm:text:NO", "key_id:text:NO",
    "signature:text:NO", "status:text:NO", "version:bigint:NO",
    "verified_at:timestamp with time zone:NO", "revoked_at:timestamp with time zone:YES",
    "revocation_reason:text:YES",
  ],
  evidence_consumptions: [
    "tenant_id:text:NO", "evidence_id:text:NO", "scope:text:NO",
    "consumption_key_hash:text:NO", "consumed_at:timestamp with time zone:NO",
  ],
});
const B127_POSTGRES_FUNCTIONS = Object.freeze({
  current_tenant: Object.freeze({
    language: "sql",
    volatility: "s",
    result: "text",
    body: "SELECT nullif(current_setting('app.tenant_id', true), '')",
  }),
  reject_immutable_change: Object.freeze({
    language: "plpgsql",
    volatility: "v",
    result: "trigger",
    body: `BEGIN
      RAISE EXCEPTION 'immutable financial or audit records cannot be changed';
    END;`,
  }),
  reject_external_evidence_payload_change: Object.freeze({
    language: "plpgsql",
    volatility: "v",
    result: "trigger",
    body: `BEGIN
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.envelope_version IS DISTINCT FROM OLD.envelope_version
         OR NEW.issuer IS DISTINCT FROM OLD.issuer
         OR NEW.provider IS DISTINCT FROM OLD.provider
         OR NEW.environment IS DISTINCT FROM OLD.environment
         OR NEW.scope IS DISTINCT FROM OLD.scope
         OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
         OR NEW.canonical_claims_sha256 IS DISTINCT FROM OLD.canonical_claims_sha256
         OR NEW.business_event_sha256 IS DISTINCT FROM OLD.business_event_sha256
         OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.nonce IS DISTINCT FROM OLD.nonce
         OR NEW.replay_policy IS DISTINCT FROM OLD.replay_policy
         OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
         OR NEW.key_id IS DISTINCT FROM OLD.key_id
         OR NEW.signature IS DISTINCT FROM OLD.signature
         OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
        RAISE EXCEPTION 'verified external evidence payload is immutable';
      END IF;
      IF OLD.status <> 'verified'
         OR NEW.status <> 'revoked'
         OR NEW.version <> OLD.version + 1
         OR NEW.revoked_at IS NULL
         OR NEW.revocation_reason IS NULL
         OR length(NEW.revocation_reason) = 0 THEN
        RAISE EXCEPTION 'external evidence may only transition once from verified to revoked';
      END IF;
      RETURN NEW;
    END;`,
  }),
});
const B127_POSTGRES_TRIGGERS = Object.freeze({
  "external_evidence:external_evidence_payload_immutable": Object.freeze({
    type: 19,
    functionName: "reject_external_evidence_payload_change",
  }),
  "external_evidence:external_evidence_no_delete": Object.freeze({
    type: 11,
    functionName: "reject_immutable_change",
  }),
  "evidence_consumptions:evidence_consumptions_immutable": Object.freeze({
    type: 27,
    functionName: "reject_immutable_change",
  }),
});

export class CertificationError extends Error {
  constructor(code, message, status = "FAIL", details = undefined) {
    super(message);
    this.name = "CertificationError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Read-only B127 source. A future database adapter only needs to implement the
 * same load({ tenantId, launchId, b126CertificationId }) contract and return
 * both the final B127 record and its prerequisite B126 certificate/evidence.
 */
export class SqliteB127CertificationSource {
  kind = "sqlite";

  constructor(databasePath) {
    this.databasePath = databasePath;
  }

  load({ tenantId, launchId, b126CertificationId }) {
    const databasePath = requiredPath(this.databasePath, "B127 database path", "B127_DATABASE_REQUIRED");
    if (!existsSync(databasePath)) {
      throw blocked("B127_DATABASE_NOT_FOUND", "The configured B127 database does not exist");
    }
    assertRegularStablePath(databasePath, "B127 database");

    let database;
    try {
      database = new DatabaseSync(databasePath, {
        readOnly: true,
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
      });
      database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;");
      const integrityRows = database.prepare("PRAGMA integrity_check").all();
      if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
        throw new CertificationError("DATABASE_INTEGRITY_FAILED", "The B127 database failed SQLite integrity_check");
      }
      assertRequiredTables(database);

      const rows = database.prepare(
        `SELECT tenant_id, collection, id, data_json, version, created_at, updated_at
           FROM records
          WHERE tenant_id = ?
            AND collection = 'capability.launching-complete-commercial-product'
            AND deleted_at IS NULL
            AND json_extract(data_json, '$.batchId') = 'B127'
            AND json_extract(data_json, '$.launchId') = ?
            AND json_extract(data_json, '$.wave') = 'global'
            AND json_extract(data_json, '$.rolloutPercent') = 100
          ORDER BY updated_at DESC, id DESC
          LIMIT 2`,
      ).all(tenantId, launchId);
      if (rows.length === 0) {
        const intermediate = database.prepare(
          `SELECT 1
             FROM records
            WHERE tenant_id = ?
              AND collection = 'capability.launching-complete-commercial-product'
              AND deleted_at IS NULL
              AND json_extract(data_json, '$.batchId') = 'B127'
              AND json_extract(data_json, '$.launchId') = ?
            LIMIT 1`,
        ).get(tenantId, launchId);
        if (intermediate !== undefined) {
          throw blocked(
            "B127_FINAL_ROLLOUT_INCOMPLETE",
            "A B127 launch record exists, but no global 100 percent record is available for final certification",
          );
        }
        throw blocked("B127_RECORD_NOT_FOUND", "No completed B127 production launch record matches the configured tenant and launch ID");
      }
      if (rows.length !== 1) {
        throw new CertificationError("B127_RECORD_AMBIGUOUS", "Multiple B127 records match the configured tenant and launch ID");
      }
      const row = rows[0];
      const data = parseJsonObject(row.data_json, "stored B127 record");
      const evidenceIds = stringArray(data.externalEvidenceIds, "externalEvidenceIds", 5, 100);
      const placeholders = evidenceIds.map(() => "?").join(", ");
      const evidence = database.prepare(
        `SELECT e.tenant_id, e.id, e.envelope_version, e.issuer, e.provider, e.environment,
                e.scope, e.artifact_sha256, e.issued_at, e.expires_at, e.nonce,
                e.replay_policy, e.algorithm, e.key_id, e.signature, e.status,
                e.version, e.verified_at, e.revoked_at, e.revocation_reason,
                c.scope AS consumption_scope, c.consumption_key_hash, c.consumed_at
           FROM external_evidence e
           LEFT JOIN evidence_consumptions c
             ON c.tenant_id = e.tenant_id AND c.evidence_id = e.id
          WHERE e.tenant_id = ? AND e.id IN (${placeholders})
          ORDER BY e.id`,
      ).all(tenantId, ...evidenceIds);
      const b126Rows = database.prepare(
        `SELECT tenant_id, collection, id, data_json, version, created_at, updated_at
           FROM records
          WHERE tenant_id = ?
            AND collection = 'capability.launching-complete-commercial-product'
            AND deleted_at IS NULL
            AND json_extract(data_json, '$.batchId') = 'B126'
            AND json_extract(data_json, '$.certificationId') = ?
          ORDER BY updated_at DESC, id DESC
          LIMIT 2`,
      ).all(tenantId, b126CertificationId);
      if (b126Rows.length === 0) {
        throw blocked("B126_CERTIFICATE_NOT_FOUND", "The release manifest B126 prerequisite certificate is not stored for this tenant");
      }
      if (b126Rows.length !== 1) {
        throw new CertificationError("B126_CERTIFICATE_AMBIGUOUS", "Multiple B126 prerequisite certificates match the release manifest");
      }
      const b126Row = b126Rows[0];
      const b126Data = parseJsonObject(b126Row.data_json, "stored B126 record");
      const b126EvidenceIds = stringArray(b126Data.externalEvidenceIds, "B126 externalEvidenceIds", 5, 100);
      const b126Placeholders = b126EvidenceIds.map(() => "?").join(", ");
      const b126Evidence = database.prepare(
        `SELECT e.tenant_id, e.id, e.envelope_version, e.issuer, e.provider, e.environment,
                e.scope, e.artifact_sha256, e.issued_at, e.expires_at, e.nonce,
                e.replay_policy, e.algorithm, e.key_id, e.signature, e.status,
                e.version, e.verified_at, e.revoked_at, e.revocation_reason,
                c.scope AS consumption_scope, c.consumption_key_hash, c.consumed_at
           FROM external_evidence e
           LEFT JOIN evidence_consumptions c
             ON c.tenant_id = e.tenant_id AND c.evidence_id = e.id
          WHERE e.tenant_id = ? AND e.id IN (${b126Placeholders})
          ORDER BY e.id`,
      ).all(tenantId, ...b126EvidenceIds);
      database.exec("COMMIT;");
      return {
        record: {
          tenantId: row.tenant_id,
          collection: row.collection,
          id: row.id,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          data,
        },
        evidence,
        b126Record: {
          tenantId: b126Row.tenant_id,
          collection: b126Row.collection,
          id: b126Row.id,
          version: b126Row.version,
          createdAt: b126Row.created_at,
          updatedAt: b126Row.updated_at,
          data: b126Data,
        },
        b126Evidence,
        sourceEvidence: {
          kind: this.kind,
          databasePath: realpathSync(databasePath),
          schemaVersion: "5",
        },
      };
    } catch (error) {
      try {
        database?.exec("ROLLBACK;");
      } catch {
        // The database may have failed before a transaction was established.
      }
      if (error instanceof CertificationError) throw error;
      throw new CertificationError("B127_DATABASE_READ_FAILED", "The B127 database could not be read safely", "FAIL", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      database?.close();
    }
  }
}

/**
 * Production B127 source. It opens one TLS-verified, repeatable-read, read-only
 * transaction, binds app.tenant_id locally, proves FORCE RLS and the runtime
 * schema contract, and rejects any role broader than the required SELECT set.
 */
export class PostgresB127CertificationSource {
  kind = "postgresql";

  constructor(connectionString, options = {}) {
    this.connectionString = validatePostgresConnectionString(
      connectionString,
      options.certificationProfile ?? "production",
      options.allowInsecureTestConnection === true,
    );
    this.certificationProfile = options.certificationProfile ?? "production";
    this.poolFactory = options.poolFactory ?? ((configuration) => new Pool(configuration));
  }

  async load({ tenantId, launchId, b126CertificationId }) {
    const pool = this.poolFactory({
      connectionString: this.connectionString,
      application_name: "ltm-b127-certifier",
      max: 1,
      min: 0,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      statement_timeout: 15_000,
      query_timeout: 20_000,
    });
    let client;
    let began = false;
    try {
      try {
        client = await pool.connect();
      } catch {
        throw blocked("B127_POSTGRES_UNAVAILABLE", "The production B127 PostgreSQL evidence source is unavailable");
      }
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      began = true;
      // Catalog deparsers such as pg_get_expr/pg_get_functiondef are sensitive
      // to search_path. Pin pg_catalog before every catalog or application query
      // so a role-level path cannot hide schema qualification or shadow helpers.
      await client.query("SET LOCAL search_path = pg_catalog");
      await client.query("SET LOCAL row_security = on");
      await client.query("SET LOCAL statement_timeout = '15s'");
      // tenantId is constrained to IDENTIFIER before source invocation, so this
      // literal SET LOCAL cannot contain SQL metacharacters.
      await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const binding = await client.query(
        "SELECT current_setting('app.tenant_id', true) AS tenant_id, current_setting('transaction_read_only') AS read_only",
      );
      if (binding.rows[0]?.tenant_id !== tenantId || binding.rows[0]?.read_only !== "on") {
        throw new CertificationError("B127_POSTGRES_CONTEXT_INVALID", "PostgreSQL did not establish a tenant-bound read-only transaction");
      }
      const contract = await verifyPostgresCertificationContract(client, this.certificationProfile);
      const recordResult = await client.query(
        `SELECT tenant_id,collection,id,data,version,created_at,updated_at
           FROM ltm.records
          WHERE tenant_id=$1
            AND collection='capability.launching-complete-commercial-product'
            AND deleted_at IS NULL
            AND data->>'batchId'='B127'
            AND data->>'launchId'=$2
            AND data @> '{"wave":"global","rolloutPercent":100}'::jsonb
          ORDER BY updated_at DESC,id DESC
          LIMIT 2`,
        [tenantId, launchId],
      );
      if (recordResult.rows.length === 0) {
        const intermediateResult = await client.query(
          `SELECT 1
             FROM ltm.records
            WHERE tenant_id=$1
              AND collection='capability.launching-complete-commercial-product'
              AND deleted_at IS NULL
              AND data->>'batchId'='B127'
              AND data->>'launchId'=$2
            LIMIT 1`,
          [tenantId, launchId],
        );
        if (intermediateResult.rows.length > 0) {
          throw blocked(
            "B127_FINAL_ROLLOUT_INCOMPLETE",
            "A B127 launch record exists, but no global 100 percent record is available for final certification",
          );
        }
        throw blocked("B127_RECORD_NOT_FOUND", "No completed B127 production launch record matches the configured tenant and launch ID");
      }
      if (recordResult.rows.length !== 1) {
        throw new CertificationError("B127_RECORD_AMBIGUOUS", "Multiple B127 records match the configured tenant and launch ID");
      }
      const row = recordResult.rows[0];
      const data = plainObject(row.data, "stored PostgreSQL B127 record");
      const evidenceIds = stringArray(data.externalEvidenceIds, "externalEvidenceIds", 5, 100);
      const evidenceResult = await client.query(
        `SELECT e.tenant_id,e.id,e.envelope_version,e.issuer,e.provider,e.environment,
                e.scope,e.artifact_sha256,e.issued_at,e.expires_at,e.nonce,
                e.replay_policy,e.algorithm,e.key_id,e.signature,e.status,
                e.version,e.verified_at,e.revoked_at,e.revocation_reason,
                c.scope AS consumption_scope,c.consumption_key_hash,c.consumed_at
           FROM ltm.external_evidence e
           LEFT JOIN ltm.evidence_consumptions c
             ON c.tenant_id=e.tenant_id AND c.evidence_id=e.id
          WHERE e.tenant_id=$1 AND e.id=ANY($2::text[])
          ORDER BY e.id`,
        [tenantId, evidenceIds],
      );
      const b126RecordResult = await client.query(
        `SELECT tenant_id,collection,id,data,version,created_at,updated_at
           FROM ltm.records
          WHERE tenant_id=$1
            AND collection='capability.launching-complete-commercial-product'
            AND deleted_at IS NULL
            AND data->>'batchId'='B126'
            AND data->>'certificationId'=$2
          ORDER BY updated_at DESC,id DESC
          LIMIT 2`,
        [tenantId, b126CertificationId],
      );
      if (b126RecordResult.rows.length === 0) {
        throw blocked("B126_CERTIFICATE_NOT_FOUND", "The release manifest B126 prerequisite certificate is not stored for this tenant");
      }
      if (b126RecordResult.rows.length !== 1) {
        throw new CertificationError("B126_CERTIFICATE_AMBIGUOUS", "Multiple B126 prerequisite certificates match the release manifest");
      }
      const b126Row = b126RecordResult.rows[0];
      const b126Data = plainObject(b126Row.data, "stored PostgreSQL B126 record");
      const b126EvidenceIds = stringArray(b126Data.externalEvidenceIds, "B126 externalEvidenceIds", 5, 100);
      const b126EvidenceResult = await client.query(
        `SELECT e.tenant_id,e.id,e.envelope_version,e.issuer,e.provider,e.environment,
                e.scope,e.artifact_sha256,e.issued_at,e.expires_at,e.nonce,
                e.replay_policy,e.algorithm,e.key_id,e.signature,e.status,
                e.version,e.verified_at,e.revoked_at,e.revocation_reason,
                c.scope AS consumption_scope,c.consumption_key_hash,c.consumed_at
           FROM ltm.external_evidence e
           LEFT JOIN ltm.evidence_consumptions c
             ON c.tenant_id=e.tenant_id AND c.evidence_id=e.id
          WHERE e.tenant_id=$1 AND e.id=ANY($2::text[])
          ORDER BY e.id`,
        [tenantId, b126EvidenceIds],
      );
      const crossTenant = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM ltm.records WHERE tenant_id<>$1 LIMIT 1) OR
           EXISTS(SELECT 1 FROM ltm.external_evidence WHERE tenant_id<>$1 LIMIT 1) OR
           EXISTS(SELECT 1 FROM ltm.evidence_consumptions WHERE tenant_id<>$1 LIMIT 1) AS leaked`,
        [tenantId],
      );
      if (crossTenant.rows[0]?.leaked !== false) {
        throw new CertificationError("B127_POSTGRES_RLS_BYPASS", "PostgreSQL exposed rows outside the bound release tenant");
      }
      await client.query("COMMIT");
      began = false;
      return {
        record: {
          tenantId: row.tenant_id,
          collection: row.collection,
          id: row.id,
          version: safeInteger(row.version, "B127 record version"),
          createdAt: postgresTimestamp(row.created_at, "B127 createdAt"),
          updatedAt: postgresTimestamp(row.updated_at, "B127 updatedAt"),
          data,
        },
        evidence: evidenceResult.rows.map(postgresEvidenceRow),
        b126Record: {
          tenantId: b126Row.tenant_id,
          collection: b126Row.collection,
          id: b126Row.id,
          version: safeInteger(b126Row.version, "B126 record version"),
          createdAt: postgresTimestamp(b126Row.created_at, "B126 createdAt"),
          updatedAt: postgresTimestamp(b126Row.updated_at, "B126 updatedAt"),
          data: b126Data,
        },
        b126Evidence: b126EvidenceResult.rows.map(postgresEvidenceRow),
        sourceEvidence: {
          kind: this.kind,
          serverVersion: contract.serverVersion,
          currentUser: contract.currentUser,
          tls: contract.tls,
          transactionReadOnly: true,
          tenantRls: "forced-and-observed",
          schemaVersion: contract.schemaVersion,
          privileges: "select-only",
        },
      };
    } catch (error) {
      if (began && client !== undefined) await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CertificationError) throw error;
      const postgresCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P02", "57P03"].includes(postgresCode)) {
        throw blocked("B127_POSTGRES_UNAVAILABLE", "The production B127 PostgreSQL evidence source became unavailable");
      }
      throw new CertificationError("B127_POSTGRES_READ_FAILED", "The production B127 PostgreSQL source could not be verified", "FAIL", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      client?.release();
      await pool.end().catch(() => undefined);
    }
  }
}

async function verifyPostgresCertificationContract(client, certificationProfile) {
  const server = await client.query(
    `SELECT current_user,session_user,current_setting('server_version_num') AS server_version_num,
            current_database() AS database_name`,
  );
  const serverRow = server.rows[0];
  const serverVersionNumber = Number(serverRow?.server_version_num);
  if (!Number.isSafeInteger(serverVersionNumber) || serverVersionNumber < 170000) {
    throw new CertificationError("B127_POSTGRES_VERSION_UNSUPPORTED", "B127 production certification requires PostgreSQL 17 or newer");
  }
  if (serverRow?.current_user !== serverRow?.session_user) {
    throw new CertificationError("B127_POSTGRES_ROLE_SWITCHED", "B127 certification forbids SET ROLE or a switched database identity");
  }
  const roleResult = await client.query(
    `SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication
       FROM pg_roles WHERE rolname=current_user`,
  );
  const role = roleResult.rows[0];
  if (
    role === undefined ||
    role.rolsuper !== false ||
    role.rolbypassrls !== false ||
    role.rolcreatedb !== false ||
    role.rolcreaterole !== false ||
    role.rolreplication !== false
  ) {
    throw new CertificationError(
      "B127_POSTGRES_ROLE_PRIVILEGED",
      "B127 PostgreSQL role must be non-superuser, non-BYPASSRLS, and have no database, role, or replication administration",
    );
  }
  const memberships = await client.query(
    `SELECT rolname FROM pg_roles
      WHERE oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
        AND pg_has_role(current_user,oid,'MEMBER')
      ORDER BY rolname`,
  );
  if (memberships.rows.length !== 0) {
    throw new CertificationError("B127_POSTGRES_ROLE_MEMBERSHIP", "B127 PostgreSQL role must not inherit or assume any other database role");
  }
  const structuralPrivileges = await client.query(
    `SELECT has_schema_privilege(current_user,'ltm','USAGE') AS schema_usage,
            has_schema_privilege(current_user,'ltm','CREATE') AS schema_create,
            has_database_privilege(current_user,current_database(),'CREATE') AS database_create`,
  );
  const structural = structuralPrivileges.rows[0];
  if (structural?.schema_usage !== true || structural.schema_create !== false || structural.database_create !== false) {
    throw new CertificationError("B127_POSTGRES_STRUCTURAL_PRIVILEGE", "B127 PostgreSQL role must have schema USAGE without schema/database CREATE privileges");
  }
  const tablePrivileges = await client.query(
    `WITH required(table_name) AS (SELECT unnest($1::text[]))
     SELECT table_name,
            has_table_privilege(current_user,'ltm.'||table_name,'SELECT') AS can_select,
            has_table_privilege(current_user,'ltm.'||table_name,'INSERT') AS can_insert,
            has_table_privilege(current_user,'ltm.'||table_name,'UPDATE') AS can_update,
            has_table_privilege(current_user,'ltm.'||table_name,'DELETE') AS can_delete,
            has_table_privilege(current_user,'ltm.'||table_name,'TRUNCATE') AS can_truncate,
            has_table_privilege(current_user,'ltm.'||table_name,'REFERENCES') AS can_reference,
            has_table_privilege(current_user,'ltm.'||table_name,'TRIGGER') AS can_trigger
       FROM required ORDER BY table_name`,
    [B127_POSTGRES_TABLES],
  );
  if (tablePrivileges.rows.length !== B127_POSTGRES_TABLES.length || tablePrivileges.rows.some((item) =>
    item.can_select !== true || item.can_insert !== false || item.can_update !== false ||
    item.can_delete !== false || item.can_truncate !== false || item.can_reference !== false || item.can_trigger !== false
  )) {
    throw new CertificationError("B127_POSTGRES_PRIVILEGES_NOT_MINIMAL", "B127 PostgreSQL role requires SELECT-only privileges on the four certification tables");
  }
  const unrelatedPrivileges = await client.query(
    `SELECT n.nspname,c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f')
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND NOT (n.nspname='ltm' AND c.relname=ANY($1::text[]))
        AND (
          has_table_privilege(current_user,c.oid,'SELECT') OR
          has_table_privilege(current_user,c.oid,'INSERT') OR
          has_table_privilege(current_user,c.oid,'UPDATE') OR
          has_table_privilege(current_user,c.oid,'DELETE') OR
          has_table_privilege(current_user,c.oid,'TRUNCATE') OR
          has_table_privilege(current_user,c.oid,'REFERENCES') OR
          has_table_privilege(current_user,c.oid,'TRIGGER')
        )
      ORDER BY n.nspname,c.relname
      LIMIT 1`,
    [B127_POSTGRES_TABLES],
  );
  const unrelatedSequencePrivileges = await client.query(
    `SELECT n.nspname,c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='S'
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND (
          has_sequence_privilege(current_user,c.oid,'USAGE') OR
          has_sequence_privilege(current_user,c.oid,'SELECT') OR
          has_sequence_privilege(current_user,c.oid,'UPDATE')
        )
      ORDER BY n.nspname,c.relname
      LIMIT 1`,
  );
  if (unrelatedPrivileges.rows.length !== 0 || unrelatedSequencePrivileges.rows.length !== 0) {
    throw new CertificationError("B127_POSTGRES_PRIVILEGES_NOT_MINIMAL", "B127 PostgreSQL role must not access unrelated application tables or sequences");
  }
  const metadata = await client.query(
    "SELECT value FROM ltm.schema_metadata WHERE key='runtime_schema_version'",
  );
  const schemaVersion = metadata.rows[0]?.value;
  if (metadata.rows.length !== 1 || !["3", "4", "5", "6", "7"].includes(schemaVersion)) {
    throw new CertificationError("B127_POSTGRES_SCHEMA_UNSUPPORTED", "B127 PostgreSQL runtime schema must be an explicitly supported version (3, 4, 5, 6, or 7)");
  }
  if (certificationProfile === "production" && schemaVersion !== "7") {
    throw blocked("B127_POSTGRES_SCHEMA_OUTDATED", "Production B127 certification requires runtime schema version 7");
  }
  const columns = await client.query(
    `SELECT table_name,column_name,data_type,is_nullable
       FROM information_schema.columns
      WHERE table_schema='ltm' AND table_name=ANY($1::text[])
      ORDER BY table_name,column_name`,
    [B127_POSTGRES_TABLES],
  );
  const actualColumns = new Map(B127_POSTGRES_TABLES.map((name) => [name, new Set()]));
  for (const column of columns.rows) {
    actualColumns.get(column.table_name)?.add(`${column.column_name}:${column.data_type}:${column.is_nullable}`);
  }
  for (const [table, required] of Object.entries(B127_POSTGRES_COLUMNS)) {
    const actual = actualColumns.get(table);
    if (actual === undefined || required.some((column) => !actual.has(column))) {
      throw new CertificationError("B127_POSTGRES_SCHEMA_INCOMPLETE", `B127 PostgreSQL table ltm.${table} does not match the runtime schema contract`);
    }
  }
  const rls = await client.query(
    `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='ltm' AND c.relname=ANY($1::text[])
      ORDER BY c.relname`,
    [B127_POSTGRES_TENANT_TABLES],
  );
  if (
    rls.rows.length !== B127_POSTGRES_TENANT_TABLES.length ||
    rls.rows.some((table) => table.relrowsecurity !== true || table.relforcerowsecurity !== true)
  ) {
    throw new CertificationError("B127_POSTGRES_RLS_NOT_FORCED", "All schema-7 PostgreSQL tenant tables must enable and force row-level security");
  }
  const policies = await client.query(
    `SELECT tablename,policyname,permissive,cmd,roles::text AS roles,qual,with_check
       FROM pg_policies
      WHERE schemaname='ltm' AND tablename=ANY($1::text[])
      ORDER BY tablename,policyname`,
    [B127_POSTGRES_TENANT_TABLES],
  );
  const partnerScopedTables = new Set(["partner_settlement_state", "partner_usage_events", "partner_rate_contracts", "partner_settlement_statements", "partner_anomaly_decisions"]);
  if (
    policies.rows.length !== B127_POSTGRES_TENANT_TABLES.length ||
    policies.rows.some((policy) => {
      const partnerScoped = partnerScopedTables.has(policy.tablename);
      const expectedExpression = partnerScoped
        ? "(partner_id = current_setting('app.partner_id'::text, true))"
        : "(tenant_id = ltm.current_tenant())";
      return policy.policyname !== "tenant_isolation" || policy.permissive !== "PERMISSIVE" || policy.cmd !== "ALL" || policy.roles !== "{public}" || policy.qual !== expectedExpression || policy.with_check !== expectedExpression;
    })
  ) {
    throw new CertificationError("B127_POSTGRES_RLS_POLICY_INVALID", "Every schema-7 tenant table must have exactly one PERMISSIVE ALL PUBLIC tenant_isolation policy bound to its tenant or partner context");
  }
  const functions = await client.query(
    `SELECT p.proname,l.lanname,p.provolatile,p.prosecdef,p.proleakproof,p.proparallel,
            p.proconfig,p.prokind,p.proisstrict,p.proretset,p.pronargs,p.prosrc,
            pg_get_function_result(p.oid) AS result
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname='ltm' AND p.pronargs=0 AND p.proname=ANY($1::text[])
      ORDER BY p.proname`,
    [Object.keys(B127_POSTGRES_FUNCTIONS)],
  );
  if (functions.rows.length !== Object.keys(B127_POSTGRES_FUNCTIONS).length) {
    throw new CertificationError("B127_POSTGRES_FUNCTION_DRIFT", "B127 PostgreSQL tenant isolation and evidence immutability functions are missing or overloaded");
  }
  for (const routine of functions.rows) {
    const expected = B127_POSTGRES_FUNCTIONS[routine.proname];
    if (
      expected === undefined ||
      routine.lanname !== expected.language ||
      routine.provolatile !== expected.volatility ||
      routine.result !== expected.result ||
      routine.prosecdef !== false ||
      routine.proleakproof !== false ||
      routine.proparallel !== "u" ||
      routine.proconfig !== null ||
      routine.prokind !== "f" ||
      routine.proisstrict !== false ||
      routine.proretset !== false ||
      Number(routine.pronargs) !== 0 ||
      normalizePostgresFunctionBody(routine.prosrc) !== normalizePostgresFunctionBody(expected.body)
    ) {
      throw new CertificationError("B127_POSTGRES_FUNCTION_DRIFT", `B127 PostgreSQL function ltm.${routine.proname} does not match the certified fail-closed definition`);
    }
  }
  const triggers = await client.query(
    `SELECT c.relname,t.tgname,t.tgenabled,t.tgtype::int AS trigger_type,
            t.tgdeferrable,t.tginitdeferred,(t.tgconstraint=0) AS unconstrained,
            pn.nspname AS function_schema,p.proname AS function_name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_proc p ON p.oid=t.tgfoid
       JOIN pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='ltm' AND NOT t.tgisinternal
        AND ((c.relname='external_evidence' AND t.tgname=ANY($1::text[]))
          OR (c.relname='evidence_consumptions' AND t.tgname='evidence_consumptions_immutable'))
      ORDER BY c.relname,t.tgname`,
    [["external_evidence_payload_immutable", "external_evidence_no_delete"]],
  );
  const requiredTriggers = new Set(Object.keys(B127_POSTGRES_TRIGGERS));
  for (const trigger of triggers.rows) {
    const key = `${trigger.relname}:${trigger.tgname}`;
    const expected = B127_POSTGRES_TRIGGERS[key];
    if (
      expected === undefined ||
      trigger.tgenabled !== "O" ||
      Number(trigger.trigger_type) !== expected.type ||
      trigger.tgdeferrable !== false ||
      trigger.tginitdeferred !== false ||
      trigger.unconstrained !== true ||
      trigger.function_schema !== "ltm" ||
      trigger.function_name !== expected.functionName
    ) continue;
    requiredTriggers.delete(key);
  }
  if (triggers.rows.length !== Object.keys(B127_POSTGRES_TRIGGERS).length || requiredTriggers.size !== 0) {
    throw new CertificationError("B127_POSTGRES_IMMUTABILITY_INCOMPLETE", "B127 PostgreSQL evidence immutability triggers are missing, drifted, disabled, or bound to the wrong function/event");
  }
  const ssl = await client.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
  const tls = ssl.rows[0]?.ssl === true;
  if (certificationProfile === "production" && !tls) {
    throw new CertificationError("B127_POSTGRES_TLS_REQUIRED", "Production B127 PostgreSQL evidence must use a verified TLS connection");
  }
  return {
    serverVersion: String(serverVersionNumber),
    currentUser: role.rolname,
    tls,
    schemaVersion,
  };
}

function normalizePostgresFunctionBody(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function validatePostgresConnectionString(value, profile, allowInsecureTestConnection) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 8_192) {
    throw blocked("B127_POSTGRES_URL_REQUIRED", "LTM_B127_POSTGRES_URL or DATABASE_URL is required for production certification");
  }
  if (!["production", "local", "test"].includes(profile)) {
    throw new CertificationError("B127_PROFILE_INVALID", "B127 certification profile must be production, local, or test");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CertificationError("B127_POSTGRES_URL_INVALID", "B127 PostgreSQL URL is invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username.length === 0 ||
    url.hostname.length === 0 ||
    url.pathname.length <= 1 ||
    url.hash.length > 0
  ) {
    throw new CertificationError("B127_POSTGRES_URL_INVALID", "B127 PostgreSQL URL must identify a role, host, and database without a fragment");
  }
  const allowedParameters = new Set([
    "sslmode", "sslrootcert", "sslcert", "sslkey", "channel_binding",
    "connect_timeout", "application_name",
  ]);
  const parameterNames = [...url.searchParams.keys()];
  const normalizedParameterNames = parameterNames.map((name) => name.toLowerCase());
  if (new Set(normalizedParameterNames).size !== normalizedParameterNames.length) {
    throw new CertificationError(
      "B127_POSTGRES_URL_PARAMETER_INVALID",
      "B127 PostgreSQL URL must not contain duplicate or case-variant query parameters",
    );
  }
  for (const [index, key] of parameterNames.entries()) {
    const normalizedKey = normalizedParameterNames[index];
    // node-postgres/libpq applies `options=-c ...` after Pool configuration.
    // Reject it under every percent-encoded or case-variant spelling rather
    // than relying on transaction-local settings as the only boundary.
    if (normalizedKey === "options" || key !== normalizedKey || !allowedParameters.has(normalizedKey)) {
      throw new CertificationError("B127_POSTGRES_URL_PARAMETER_INVALID", `B127 PostgreSQL URL parameter ${key} is not allowed`);
    }
  }
  if (profile === "production") {
    if (url.searchParams.get("sslmode") !== "verify-full") {
      throw new CertificationError("B127_POSTGRES_TLS_CONFIG_INVALID", "Production B127 PostgreSQL URL must set sslmode=verify-full");
    }
  } else if (url.searchParams.get("sslmode") !== "verify-full") {
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (!allowInsecureTestConnection || profile !== "test" || !loopback || url.searchParams.get("sslmode") !== "disable") {
      throw new CertificationError("B127_POSTGRES_TLS_CONFIG_INVALID", "Insecure PostgreSQL is allowed only for an explicit loopback test profile");
    }
  }
  return url.toString();
}

function postgresEvidenceRow(row) {
  return {
    ...row,
    issued_at: postgresTimestamp(row.issued_at, `${row.id}.issuedAt`),
    expires_at: postgresTimestamp(row.expires_at, `${row.id}.expiresAt`),
    verified_at: postgresTimestamp(row.verified_at, `${row.id}.verifiedAt`),
    revoked_at: row.revoked_at === null ? null : postgresTimestamp(row.revoked_at, `${row.id}.revokedAt`),
    consumed_at: row.consumed_at === null ? null : postgresTimestamp(row.consumed_at, `${row.id}.consumedAt`),
    version: safeInteger(row.version, `${row.id}.version`),
  };
}

function postgresTimestamp(value, label) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return canonicalTimestamp(value, label).toISOString();
}

function safeInteger(value, label) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CertificationError("B127_POSTGRES_VALUE_INVALID", `${label} must be a positive safe integer`);
  }
  return number;
}

export async function verifyB127Certification(options) {
  const root = realpathSync(resolve(options.root ?? process.cwd()));
  const certificationProfile = options.certificationProfile ?? "test";
  if (!["production", "local", "test"].includes(certificationProfile)) {
    throw new CertificationError("B127_PROFILE_INVALID", "B127 certification profile must be production, local, or test");
  }
  const tenantId = requiredIdentifier(options.tenantId, "tenantId", "RELEASE_TENANT_REQUIRED");
  const launchId = requiredIdentifier(options.launchId, "launchId", "RELEASE_LAUNCH_ID_REQUIRED");
  const expectedCommit = exactCommit(options.expectedCommit, "expectedCommit");
  const now = validDate(options.now ?? new Date(), "verification clock");
  const manifestFile = readStableFile(
    requiredPath(options.manifestPath, "release manifest path", "RELEASE_MANIFEST_REQUIRED"),
    "release manifest",
    MAX_MANIFEST_BYTES,
  );
  const manifest = parseJsonObject(manifestFile.bytes.toString("utf8"), "release manifest");
  const b126CertificationId = manifestB126CertificationId(manifest);
  const manifestSha256 = sha256Bytes(manifestFile.bytes);
  const trustedKeys = loadTrustedKeys(options.trustedKeysPath, now);
  const source = options.source ?? (options.postgresUrl === undefined
    ? new SqliteB127CertificationSource(options.databasePath)
    : new PostgresB127CertificationSource(options.postgresUrl, {
        certificationProfile,
        allowInsecureTestConnection: options.allowInsecureTestConnection === true,
      }));
  if (certificationProfile === "production" && source.kind !== "postgresql") {
    throw new CertificationError(
      "B127_PRODUCTION_SOURCE_INVALID",
      "Production B127 certification requires the live PostgreSQL/RLS source; SQLite is limited to local and test evidence",
      "BLOCKED_EXTERNAL",
    );
  }
  const candidate = await source.load({ tenantId, launchId, b126CertificationId });

  const record = validateRecord(candidate.record, {
    tenantId,
    launchId,
    expectedCommit,
    manifestSha256,
    now,
  });
  const validatedManifest = validateManifest(manifest, {
    root,
    tenantId,
    launchId,
    expectedCommit,
    record,
    now,
    trustedKeys,
  });
  const b126Record = validateB126Certificate(candidate.b126Record, validatedManifest.b126Certification, {
    tenantId,
    manifestGeneratedAt: validatedManifest.generatedAt,
  });
  const b126Evidence = validateEvidenceSet(candidate.b126Evidence, {
    batchId: "B126",
    tenantId,
    expectedScope: b126Record.evidenceScope,
    expectedArtifactSha256: b126Record.scenarioArtifactSha256,
    expectedProvider: `e2e-auditor:${b126Record.auditorProviderId}`,
    expectedIds: b126Record.externalEvidenceIds,
    trustedKeys,
    now,
    maximumConsumedAt: validatedManifest.generatedAt,
  });
  const sbomFile = validatedManifest.sbom.file;
  const sbomSha256 = sha256Bytes(sbomFile.bytes);
  if (sbomSha256 !== validatedManifest.sbom.sha256 || sbomSha256 !== record.sbomDigest) {
    throw new CertificationError("SBOM_DIGEST_MISMATCH", "The SBOM file digest does not match the manifest and B127 record");
  }
  validateSbom(sbomFile.bytes, validatedManifest.sbom.format);

  const evidence = validateEvidenceSet(candidate.evidence, {
    batchId: "B127",
    tenantId,
    expectedScope: record.evidenceScope,
    expectedArtifactSha256: manifestSha256,
    expectedProvider: `release-control:${record.releaseControlProviderId}`,
    expectedIds: record.externalEvidenceIds,
    trustedKeys,
    now,
    minimumIssuedAt: validatedManifest.generatedAt,
    minimumConsumedAt: validatedManifest.rollout.globalWaveObservation.completedAt,
  });
  validateApprovalEvidence(validatedManifest.approvals, evidence, record.approvalIds, trustedKeys);
  validateProductionChangeSignerSeparation(validatedManifest.approvals.productionChangeApproval, evidence, trustedKeys);
  const allEvidenceIds = [...b126Record.externalEvidenceIds, ...record.externalEvidenceIds];
  if (new Set(allEvidenceIds).size !== allEvidenceIds.length) {
    throw new CertificationError("B126_B127_EVIDENCE_REUSE", "B126 and B127 must consume distinct single-use evidence envelopes");
  }

  return {
    schemaVersion: "ltm.b127-certification-result.v1",
    status: "PASS",
    verifiedAt: now.toISOString(),
    tenantId,
    launchId,
    recordId: candidate.record.id,
    recordVersion: candidate.record.version,
    commit: expectedCommit,
    manifest: {
      path: manifestFile.path,
      sha256: manifestSha256,
      schemaVersion: manifest.schemaVersion,
    },
    sbom: {
      path: sbomFile.path,
      sha256: sbomSha256,
      format: validatedManifest.sbom.format,
    },
    evidence: {
      count: evidence.length,
      distinctTrustedSigners: new Set(evidence.map((item) => `${item.issuer}\n${item.key_id}`)).size,
      evidenceIds: evidence.map((item) => item.id).sort(),
    },
    prerequisiteB126: {
      recordId: candidate.b126Record.id,
      recordVersion: candidate.b126Record.version,
      certificationId: b126Record.certificationId,
      artifact: validatedManifest.b126Certification.artifact,
      evidence: {
        count: b126Evidence.length,
        distinctTrustedSigners: new Set(b126Evidence.map((item) => `${item.issuer}\n${item.key_id}`)).size,
        evidenceIds: b126Evidence.map((item) => item.id).sort(),
      },
    },
    selectedProfile: validatedManifest.selectedProfile,
    batchReports: {
      batchCount: validatedManifest.batchReports.batchCount,
      requirementCount: validatedManifest.batchReports.requirementCount,
      reportSetSha256: validatedManifest.batchReports.reportSetSha256,
      artifact: validatedManifest.batchReports.artifact,
    },
    componentSetSha256: validatedManifest.componentSetSha256,
    releaseSubject: validatedManifest.releaseSubject,
    releaseSubjectSha256: productionReleaseSubjectSha256(validatedManifest.releaseSubject),
    policyAuthority: validatedManifest.policyAuthority,
    releaseControls: {
      waveObservationSetSha256: validatedManifest.rollout.waveObservationSetSha256,
      completedWaveObservations: validatedManifest.rollout.completedWaves.map((wave) => ({
        wave: wave.wave,
        reportId: wave.observation.reportId,
        artifact: wave.observationArtifact,
      })),
      globalWaveObservation: {
        wave: validatedManifest.rollout.globalWaveObservation.wave,
        rolloutPercent: validatedManifest.rollout.globalWaveObservation.rolloutPercent,
        startedAt: validatedManifest.rollout.globalWaveObservation.startedAt,
        completedAt: validatedManifest.rollout.globalWaveObservation.completedAt,
        reportId: validatedManifest.rollout.globalWaveObservation.observation.reportId,
        artifact: validatedManifest.rollout.globalWaveObservation.observationArtifact,
      },
      rollbackForwardDrill: {
        reportId: validatedManifest.rollout.rollbackForwardDrill.reportId,
        exerciseId: validatedManifest.rollout.rollbackForwardDrill.exerciseId,
        scopeSetSha256: validatedManifest.rollout.rollbackForwardDrill.scopeSetSha256,
        artifact: validatedManifest.rollout.rollbackForwardDrillArtifact,
      },
    },
    goLive: validatedManifest.goLive,
    operationsHandoff: validatedManifest.operationsHandoff,
    dataSource: candidate.sourceEvidence ?? { kind: source.kind ?? "custom" },
    approvals: Object.fromEntries(
      Object.entries(validatedManifest.approvals).map(([name, approval]) => [name, {
        approvalId: approval.approvalId,
        decision: approval.decision,
        authority: approval.authority,
        authorityRole: approval.authorityRole,
        issuer: approval.issuer,
        evidenceId: approval.evidenceId,
        artifact: approval.artifact,
        approvedAt: approval.approvedAt,
        ...(approval.approverSignatures === undefined ? {} : {
          approvers: approval.approverSignatures.map((entry) => ({
            evidenceId: entry.evidenceId,
            approverId: entry.approverId,
            issuer: entry.issuer,
            keyId: entry.keyId,
            authorityRole: entry.authorityRole,
            artifact: entry.artifact,
          })),
        }),
      }]),
    ),
  };
}

export async function certifyB127(options) {
  try {
    return await verifyB127Certification(options);
  } catch (error) {
    if (error instanceof CertificationError) {
      return {
        schemaVersion: "ltm.b127-certification-result.v1",
        status: error.status,
        verifiedAt: validDate(options.now ?? new Date(), "verification clock").toISOString(),
        code: error.code,
        evidence: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
    return {
      schemaVersion: "ltm.b127-certification-result.v1",
      status: "FAIL",
      verifiedAt: new Date().toISOString(),
      code: "UNEXPECTED_CERTIFIER_ERROR",
      evidence: "The B127 verifier failed unexpectedly",
      details: { cause: error instanceof Error ? error.name : "unknown" },
    };
  }
}

function validateRecord(recordEnvelope, expected) {
  if (!recordEnvelope || typeof recordEnvelope !== "object") {
    throw new CertificationError("B127_RECORD_INVALID", "The B127 source returned an invalid record");
  }
  if (recordEnvelope.tenantId !== expected.tenantId) {
    throw new CertificationError("B127_TENANT_MISMATCH", "The B127 record tenant does not match the release tenant");
  }
  const recordCreatedAt = canonicalTimestamp(recordEnvelope.createdAt, "B127 record createdAt");
  if (recordCreatedAt.getTime() > expected.now.getTime() + CLOCK_SKEW_MS) {
    throw new CertificationError("B127_RECORD_FROM_FUTURE", "The B127 record creation time is in the future");
  }
  const data = plainObject(recordEnvelope.data, "B127 record data");
  for (const [field, value] of Object.entries({
    batchId: "B127",
    operation: "approveStagedProductionLaunch",
    operationMode: "attestation",
    executionState: "evidence_persisted",
    state: "wave_approved",
    providerEnvironment: "production",
  })) {
    if (data[field] !== value) {
      throw blocked("B127_NOT_PRODUCTION_COMPLETE", `B127 ${field} is not ${value}`);
    }
  }
  if (data.launchId !== expected.launchId) {
    throw new CertificationError("B127_LAUNCH_MISMATCH", "The B127 record launch ID does not match the requested launch");
  }
  const repositoryCommit = exactCommit(data.repositoryCommit, "B127 repositoryCommit");
  const artifactCommit = exactCommit(data.artifactCommit, "B127 artifactCommit");
  if (repositoryCommit !== artifactCommit || repositoryCommit !== expected.expectedCommit) {
    throw new CertificationError("B127_COMMIT_MISMATCH", "B127 repository, artifact, and checked-out commits are not identical");
  }
  const releaseManifestDigest = exactSha256(data.releaseManifestDigest, "B127 releaseManifestDigest");
  if (releaseManifestDigest !== expected.manifestSha256) {
    throw new CertificationError("RELEASE_MANIFEST_DIGEST_MISMATCH", "The release manifest digest does not match the B127 record");
  }
  const sbomDigest = exactSha256(data.sbomDigest, "B127 sbomDigest");
  const releaseControlProviderId = identifier(data.releaseControlProviderId, "B127 releaseControlProviderId");
  const evidenceScope = nonEmptyText(data.evidenceScope, "B127 evidenceScope", 512);
  const calculatedScope = b127EvidenceScope({
    tenantId: expected.tenantId,
    provider: `release-control:${releaseControlProviderId}`,
    artifactSha256: releaseManifestDigest,
    launchId: expected.launchId,
  });
  if (evidenceScope !== calculatedScope) {
    throw new CertificationError("B127_SCOPE_MISMATCH", "The stored B127 evidence scope is not the exact production release scope");
  }
  const releaseGates = stringArray(data.releaseGates, "B127 releaseGates", 12, 64);
  requireMembers(releaseGates, REQUIRED_RELEASE_GATES, "B127 releaseGates");
  const monitoringDomains = stringArray(
    data.monitoringDomains,
    "B127 monitoringDomains",
    REQUIRED_B127_MONITORING_DOMAINS.length,
    REQUIRED_B127_MONITORING_DOMAINS.length,
  );
  requireMembers(monitoringDomains, REQUIRED_B127_MONITORING_DOMAINS, "B127 monitoringDomains");
  const approvalIds = stringArray(data.approvalIds, "B127 approvalIds", Object.keys(REQUIRED_APPROVALS).length, 100);
  const guardrailPolicySha256 = exactSha256(data.guardrailPolicySha256, "B127 guardrailPolicySha256");
  const waveObservationSetSha256 = exactSha256(data.waveObservationSetSha256, "B127 waveObservationSetSha256");
  const globalWaveObservationPath = safeRelativePath(data.globalWaveObservationPath, "B127 globalWaveObservationPath");
  const globalWaveObservationSha256 = exactSha256(data.globalWaveObservationSha256, "B127 globalWaveObservationSha256");
  const rollbackForwardDrillSha256 = exactSha256(data.rollbackForwardDrillSha256, "B127 rollbackForwardDrillSha256");
  const changeApproverEvidenceIds = stringArray(data.changeApproverEvidenceIds, "B127 changeApproverEvidenceIds", 2, 2)
    .map((id) => identifier(id, "B127 change approver evidenceId"));
  const externalEvidenceIds = stringArray(data.externalEvidenceIds, "B127 externalEvidenceIds", 5, 100).map((id) => identifier(id, "evidenceId"));
  if (!Number.isSafeInteger(data.activeGuardrailBreaches) || data.activeGuardrailBreaches !== 0) {
    throw blocked("ACTIVE_GUARDRAIL_BREACH", "B127 has an active production guardrail breach");
  }
  if (data.wave !== "global" || data.rolloutPercent !== 100) {
    throw blocked("B127_FINAL_ROLLOUT_INCOMPLETE", "B127 final certification requires the global wave at exactly 100 percent; canary and regional waves remain intermediate");
  }
  canonicalTimestamp(data.waveStartedAt, "B127 waveStartedAt");
  identifier(data.rollbackExerciseId, "B127 rollbackExerciseId");
  nonEmptyText(data.automaticPausePolicyVersion, "B127 automaticPausePolicyVersion", 200);
  return {
    ...data,
    repositoryCommit,
    artifactCommit,
    releaseManifestDigest,
    sbomDigest,
    releaseControlProviderId,
    evidenceScope,
    releaseGates,
    monitoringDomains,
    approvalIds,
    guardrailPolicySha256,
    waveObservationSetSha256,
    globalWaveObservationPath,
    globalWaveObservationSha256,
    rollbackForwardDrillSha256,
    changeApproverEvidenceIds,
    externalEvidenceIds,
    recordCreatedAt: recordCreatedAt.toISOString(),
  };
}

function manifestB126CertificationId(manifest) {
  if (!Object.prototype.hasOwnProperty.call(manifest, "b126Certification")) {
    throw blocked("B126_CERTIFICATE_REFERENCE_MISSING", "The release manifest must reference its prerequisite B126 certificate");
  }
  const reference = plainObject(manifest.b126Certification, "manifest b126Certification");
  return identifier(reference.certificationId, "manifest b126Certification.certificationId");
}

function validateManifest(manifestValue, { root, tenantId, launchId, expectedCommit, record, now, trustedKeys }) {
  const manifest = plainObject(manifestValue, "release manifest");
  requireExactObjectKeys(manifest, [
    "schemaVersion", "generatedAt", "tenantId", "launchId", "environment", "deploymentScope",
    "releaseControlProviderId", "repositoryCommit", "artifactCommit", "selectedProfile",
    "componentVersions", "componentSetSha256", "batchReports", "b126Certification", "sbom",
    "releaseSubject", "rollout", "approvals", "goLive", "operationsHandoff", "exceptions",
  ], "release manifest");
  if (manifest.schemaVersion !== "ltm.production-release-manifest.v1") {
    throw new CertificationError("RELEASE_MANIFEST_SCHEMA_INVALID", "The release manifest schemaVersion is unsupported");
  }
  if (manifest.environment !== "production" || manifest.deploymentScope !== "production") {
    throw new CertificationError("RELEASE_SCOPE_NOT_PRODUCTION", "The release manifest must be bound to production scope");
  }
  if (manifest.tenantId !== tenantId || manifest.launchId !== launchId) {
    throw new CertificationError("RELEASE_IDENTITY_MISMATCH", "The release manifest tenant or launch ID does not match B127");
  }
  if (manifest.releaseControlProviderId !== record.releaseControlProviderId) {
    throw new CertificationError("RELEASE_PROVIDER_MISMATCH", "The release manifest control provider does not match B127");
  }
  const repositoryCommit = exactCommit(manifest.repositoryCommit, "manifest repositoryCommit");
  const artifactCommit = exactCommit(manifest.artifactCommit, "manifest artifactCommit");
  if (repositoryCommit !== artifactCommit || repositoryCommit !== expectedCommit || repositoryCommit !== record.repositoryCommit) {
    throw new CertificationError("RELEASE_COMMIT_MISMATCH", "Manifest, B127, artifact, and checked-out commits are not identical");
  }
  const generatedAt = canonicalTimestamp(manifest.generatedAt, "manifest generatedAt");
  if (generatedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw new CertificationError("RELEASE_MANIFEST_FROM_FUTURE", "The release manifest was generated in the future");
  }

  const artifactPaths = new Map();
  const sbom = plainObject(manifest.sbom, "manifest sbom");
  if (sbom.format !== "cyclonedx-json" && sbom.format !== "spdx-json") {
    throw new CertificationError("SBOM_FORMAT_INVALID", "The manifest SBOM format must be cyclonedx-json or spdx-json");
  }
  const sbomResult = validateManifestArtifact(
    root,
    sbom,
    "SBOM",
    MAX_SBOM_BYTES,
    artifactPaths,
    "SBOM_DIGEST_MISMATCH",
  );
  if (sbomResult.artifact.sha256 !== record.sbomDigest) {
    throw new CertificationError("SBOM_RECORD_MISMATCH", "The manifest SBOM digest does not match B127");
  }

  const selectedProfileValue = plainObject(manifest.selectedProfile, "manifest selectedProfile");
  if (selectedProfileValue.name !== "full-commercial") {
    throw blocked("RELEASE_PROFILE_INCOMPLETE", "B127 final certification requires the full-commercial profile");
  }
  const selectedProfile = {
    name: "full-commercial",
    version: releaseVersion(selectedProfileValue.version, "manifest selectedProfile.version"),
    artifact: validateManifestArtifact(
      root,
      selectedProfileValue.artifact,
      "selected profile artifact",
      MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
      artifactPaths,
      "PROFILE_ARTIFACT_DIGEST_MISMATCH",
    ).artifact,
  };

  const componentVersionsValue = plainObject(manifest.componentVersions, "manifest componentVersions");
  requireExactObjectKeys(componentVersionsValue, REQUIRED_COMPONENT_VERSIONS, "manifest componentVersions");
  const componentVersions = {};
  for (const componentName of REQUIRED_COMPONENT_VERSIONS) {
    const component = plainObject(componentVersionsValue[componentName], `manifest componentVersions.${componentName}`);
    componentVersions[componentName] = {
      version: releaseVersion(component.version, `manifest componentVersions.${componentName}.version`),
      artifact: validateManifestArtifact(
        root,
        component.artifact,
        `${componentName} release artifact`,
        MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
        artifactPaths,
        "COMPONENT_ARTIFACT_DIGEST_MISMATCH",
      ).artifact,
    };
  }
  const componentSetSha256 = exactSha256(manifest.componentSetSha256, "manifest componentSetSha256");
  if (componentSetSha256 !== sha256Bytes(Buffer.from(canonicalJson(componentVersionsForDigest(componentVersions)), "utf8"))) {
    throw new CertificationError("COMPONENT_SET_DIGEST_MISMATCH", "The component version set digest does not match the immutable component entries");
  }

  const batchReportsValue = plainObject(manifest.batchReports, "manifest batchReports");
  if (batchReportsValue.batchCount !== 128 || batchReportsValue.requirementCount !== 640 || batchReportsValue.status !== "passed") {
    throw blocked("BATCH_REPORT_COVERAGE_INCOMPLETE", "Final certification requires 128 passed batch reports covering all 640 requirements");
  }
  const batchReportGeneratedAt = canonicalTimestamp(batchReportsValue.generatedAt, "manifest batchReports.generatedAt");
  if (batchReportGeneratedAt > generatedAt) {
    throw new CertificationError("BATCH_REPORT_AFTER_MANIFEST", "The batch report set was generated after the release manifest");
  }
  const unresolvedBatchBlockers = stringArray(batchReportsValue.unresolvedBlockers, "manifest batchReports.unresolvedBlockers", 0, 0);
  const reportHashesValue = plainObject(batchReportsValue.reportHashes, "manifest batchReports.reportHashes");
  requireExactObjectKeys(reportHashesValue, EXPECTED_BATCH_IDS, "manifest batchReports.reportHashes");
  const reportHashes = Object.fromEntries(EXPECTED_BATCH_IDS.map((batchId) => [
    batchId,
    exactSha256(reportHashesValue[batchId], `manifest batchReports.reportHashes.${batchId}`),
  ]));
  if (new Set(Object.values(reportHashes)).size !== EXPECTED_BATCH_IDS.length) {
    throw new CertificationError("BATCH_REPORT_DIGEST_REUSED", "Every B00-B127 batch report must have its own digest");
  }
  const reportSetSha256 = exactSha256(batchReportsValue.reportSetSha256, "manifest batchReports.reportSetSha256");
  if (reportSetSha256 !== sha256Bytes(Buffer.from(canonicalJson(reportHashes), "utf8"))) {
    throw new CertificationError("BATCH_REPORT_SET_DIGEST_MISMATCH", "The aggregate B00-B127 report digest does not match the manifest report map");
  }
  const batchReportArtifactResult = validateManifestArtifact(
    root,
    batchReportsValue.artifact,
    "B00-B127 certification report",
    MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
    artifactPaths,
    "BATCH_REPORT_ARTIFACT_DIGEST_MISMATCH",
  );
  const expectedBatchReportDocument = {
    schemaVersion: "ltm.batch-certification-report.v1",
    repositoryCommit,
    profile: { name: selectedProfile.name, version: selectedProfile.version },
    generatedAt: batchReportGeneratedAt.toISOString(),
    status: "passed",
    batchCount: 128,
    requirementCount: 640,
    unresolvedBlockers: unresolvedBatchBlockers,
    reportHashes,
    reportSetSha256,
  };
  const batchReportDocument = parseJsonObject(batchReportArtifactResult.file.bytes.toString("utf8"), "B00-B127 certification report");
  if (canonicalJson(batchReportDocument) !== canonicalJson(expectedBatchReportDocument)) {
    throw new CertificationError("BATCH_REPORT_ARTIFACT_CONTENT_MISMATCH", "The batch report artifact content does not exactly match its manifest summary");
  }
  const batchReports = {
    generatedAt: batchReportGeneratedAt.toISOString(),
    status: "passed",
    batchCount: 128,
    requirementCount: 640,
    unresolvedBlockers: unresolvedBatchBlockers,
    reportHashes,
    reportSetSha256,
    artifact: batchReportArtifactResult.artifact,
  };

  const b126Value = plainObject(manifest.b126Certification, "manifest b126Certification");
  const b126Certification = {
    certificationId: identifier(b126Value.certificationId, "manifest b126Certification.certificationId"),
    recordId: identifier(b126Value.recordId, "manifest b126Certification.recordId"),
    auditorProviderId: identifier(b126Value.auditorProviderId, "manifest b126Certification.auditorProviderId"),
    evidenceIds: stringArray(b126Value.evidenceIds, "manifest b126Certification.evidenceIds", 5, 100)
      .map((value) => identifier(value, "manifest B126 evidenceId")),
    artifact: validateManifestArtifact(
      root,
      b126Value.artifact,
      "B126 commercial E2E certificate",
      MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
      artifactPaths,
      "B126_ARTIFACT_DIGEST_MISMATCH",
    ).artifact,
  };

  const rolloutValue = plainObject(manifest.rollout, "manifest rollout");
  requireExactObjectKeys(rolloutValue, [
    "wave", "rolloutPercent", "waveStartedAt", "rollbackExerciseId",
    "automaticPausePolicyVersion", "guardrailPolicyArtifact", "completedWaves", "rollbackForwardDrillArtifact",
  ], "manifest rollout");
  if (
    rolloutValue.wave !== record.wave ||
    rolloutValue.rolloutPercent !== record.rolloutPercent ||
    rolloutValue.waveStartedAt !== record.waveStartedAt ||
    rolloutValue.rollbackExerciseId !== record.rollbackExerciseId ||
    rolloutValue.automaticPausePolicyVersion !== record.automaticPausePolicyVersion
  ) {
    throw new CertificationError("RELEASE_ROLLOUT_MISMATCH", "The release manifest rollout does not match the B127 record");
  }
  if (rolloutValue.wave !== "global" || rolloutValue.rolloutPercent !== 100) {
    throw blocked("B127_FINAL_ROLLOUT_INCOMPLETE", "The release manifest has not reached the global 100 percent wave");
  }
  const waveStartedAt = canonicalTimestamp(rolloutValue.waveStartedAt, "manifest rollout.waveStartedAt");
  if (waveStartedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw new CertificationError("GLOBAL_WAVE_FROM_FUTURE", "The global release wave has not started");
  }
  const releaseSubjectRolloutBinding = plainObject(manifest.releaseSubject, "manifest releaseSubject");
  const deploymentId = identifier(
    releaseSubjectRolloutBinding.deploymentId,
    "manifest releaseSubject.deploymentId",
  );
  const automaticPausePolicyVersion = releaseVersion(
    rolloutValue.automaticPausePolicyVersion,
    "manifest rollout.automaticPausePolicyVersion",
  );
  const guardrailPolicyArtifactResult = validateManifestArtifact(
    root,
    rolloutValue.guardrailPolicyArtifact,
    "canonical rollout guardrail policy",
    MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
    artifactPaths,
    "GUARDRAIL_POLICY_ARTIFACT_DIGEST_MISMATCH",
  );
  const guardrailPolicy = mapReleaseControlValidation(() => validateRolloutGuardrailPolicy(
    guardrailPolicyArtifactResult.file.bytes,
    {
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      policyVersion: automaticPausePolicyVersion,
    },
  ));
  const completedWaves = validateCompletedWaves(
    rolloutValue.completedWaves,
    {
      root,
      artifactPaths,
      globalWaveStartedAt: waveStartedAt,
      now,
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      automaticPausePolicyVersion,
      guardrailPolicy,
      guardrailPolicySha256: guardrailPolicyArtifactResult.artifact.sha256,
      trustedKeys,
    },
  );
  const globalWaveObservation = validateGlobalWaveObservation(
    {
      path: record.globalWaveObservationPath,
      sha256: record.globalWaveObservationSha256,
    },
    {
      root,
      artifactPaths,
      globalWaveStartedAt: waveStartedAt,
      now,
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      automaticPausePolicyVersion,
      guardrailPolicy,
      guardrailPolicySha256: guardrailPolicyArtifactResult.artifact.sha256,
      trustedKeys,
    },
  );
  if (canonicalTimestamp(record.recordCreatedAt, "B127 record createdAt") < canonicalTimestamp(globalWaveObservation.completedAt, "global wave completedAt")) {
    throw blocked("B127_RECORD_PREDATES_GLOBAL_OBSERVATION", "The B127 record was created before the global wave observation completed");
  }
  validateWaveEvidenceUniqueness([...completedWaves, globalWaveObservation]);
  const waveObservationSetSha256 = waveObservationArtifactSetSha256(
    completedWaves.map((wave) => ({ wave: wave.wave, sha256: wave.observationArtifact.sha256 })),
  );
  const rollbackExerciseId = identifier(
    rolloutValue.rollbackExerciseId,
    "manifest rollout.rollbackExerciseId",
  );
  const rollbackForwardDrillArtifactResult = validateManifestArtifact(
    root,
    rolloutValue.rollbackForwardDrillArtifact,
    "rollback-forward drill report",
    MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
    artifactPaths,
    "ROLLBACK_DRILL_ARTIFACT_DIGEST_MISMATCH",
  );
  const rollbackForwardDrill = mapReleaseControlValidation(() => validateRollbackForwardDrill(
    rollbackForwardDrillArtifactResult.file.bytes,
    {
      exerciseId: rollbackExerciseId,
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      maximumCompletedAt: waveStartedAt.toISOString(),
      readArtifact(reference, label) {
        return validateManifestArtifact(
          root,
          reference,
          label,
          MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
          artifactPaths,
          "ROLLBACK_DRILL_EVIDENCE_DIGEST_MISMATCH",
        ).file.bytes;
      },
    },
  ));
  const rollout = {
    wave: "global",
    rolloutPercent: 100,
    waveStartedAt: waveStartedAt.toISOString(),
    rollbackExerciseId,
    automaticPausePolicyVersion,
    guardrailPolicyArtifact: guardrailPolicyArtifactResult.artifact,
    guardrailPolicy,
    completedWaves,
    globalWaveObservation,
    waveObservationSetSha256,
    rollbackForwardDrillArtifact: rollbackForwardDrillArtifactResult.artifact,
    rollbackForwardDrill,
  };
  if (
    record.guardrailPolicySha256 !== guardrailPolicyArtifactResult.artifact.sha256 ||
    record.waveObservationSetSha256 !== waveObservationSetSha256 ||
    record.rollbackForwardDrillSha256 !== rollbackForwardDrillArtifactResult.artifact.sha256
  ) {
    throw new CertificationError("B127_RELEASE_CONTROL_BINDING_MISMATCH", "The stored B127 record does not bind the exact guardrail policy, wave set, and rollback-forward drill artifacts");
  }

  const goLiveValue = plainObject(manifest.goLive, "manifest goLive");
  requireExactObjectKeys(goLiveValue, ["windowStart", "windowEnd", "scheduledAt", "changeApprovalId"], "manifest goLive");
  const windowStart = canonicalTimestamp(goLiveValue.windowStart, "manifest goLive.windowStart");
  const windowEnd = canonicalTimestamp(goLiveValue.windowEnd, "manifest goLive.windowEnd");
  const scheduledAt = canonicalTimestamp(goLiveValue.scheduledAt, "manifest goLive.scheduledAt");
  if (
    windowEnd <= windowStart ||
    scheduledAt < windowStart || scheduledAt > windowEnd ||
    scheduledAt < generatedAt ||
    scheduledAt.toISOString() !== rollout.waveStartedAt ||
    windowEnd.getTime() - windowStart.getTime() > 72 * 60 * 60_000
  ) {
    throw new CertificationError("GO_LIVE_WINDOW_INVALID", "The global wave must start inside a bounded approved go-live window after manifest generation");
  }
  const changeApprovalId = identifier(goLiveValue.changeApprovalId, "manifest goLive.changeApprovalId");
  const goLive = {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    scheduledAt: scheduledAt.toISOString(),
    changeApprovalId,
  };

  const releaseSubjectValidation = validateManifestReleaseSubject(manifest.releaseSubject, {
    root,
    generatedAt,
    now,
    expectedCommit,
    selectedProfile,
    componentVersions,
    componentSetSha256,
    sbom: { ...sbomResult, format: sbom.format },
    goLive,
    artifactPaths,
    trustedKeys,
    rollout,
  });
  const releaseSubject = releaseSubjectValidation.subject;

  const approvalsValue = plainObject(manifest.approvals, "manifest approvals");
  for (const name of REQUIRED_APPROVAL_NAMES) {
    if (!(name in approvalsValue)) throw blocked("EXTERNAL_APPROVAL_MISSING", `The release manifest is missing ${name}`);
  }
  requireExactObjectKeys(approvalsValue, REQUIRED_APPROVAL_NAMES, "manifest approvals");
  const approvals = {};
  const approvalArtifacts = new Map();
  for (const [name, requiredDecision] of Object.entries(REQUIRED_APPROVALS)) {
    if (!(name in approvalsValue)) {
      throw blocked("EXTERNAL_APPROVAL_MISSING", `The release manifest is missing ${name}`);
    }
    const approval = plainObject(approvalsValue[name], `manifest approvals.${name}`);
    const decision = nonEmptyText(approval.decision, `${name}.decision`, 32);
    if (decision !== requiredDecision) {
      throw blocked("EXTERNAL_APPROVAL_NOT_GRANTED", `${name} decision is not ${requiredDecision}`);
    }
    const approvedAt = canonicalTimestamp(approval.approvedAt, `${name}.approvedAt`);
    if (approvedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      throw new CertificationError("EXTERNAL_APPROVAL_FROM_FUTURE", `${name} approval timestamp is in the future`);
    }
    if (approvedAt > generatedAt) {
      throw new CertificationError("EXTERNAL_APPROVAL_AFTER_MANIFEST", `${name} was approved after the release manifest was generated`);
    }
    let expiresAt;
    if (approval.expiresAt !== undefined && approval.expiresAt !== null) {
      expiresAt = canonicalTimestamp(approval.expiresAt, `${name}.expiresAt`);
      if (expiresAt.getTime() <= now.getTime() || expiresAt <= approvedAt) {
        throw blocked("EXTERNAL_APPROVAL_EXPIRED", `${name} approval has expired`);
      }
    }
    const artifact = plainObject(approval.artifact, `${name}.artifact`);
    const artifactPath = canonicalArtifactPath(root, artifact.path, `${name}.artifact.path`);
    const artifactSha256 = exactSha256(artifact.sha256, `${name}.artifact.sha256`);
    const artifactFile = readRootRelativeFile(root, artifactPath, `${name} approval artifact`, MAX_APPROVAL_ARTIFACT_BYTES);
    if (sha256Bytes(artifactFile.bytes) !== artifactSha256) {
      throw new CertificationError("APPROVAL_ARTIFACT_DIGEST_MISMATCH", `${name} approval artifact digest does not match the release manifest`);
    }
    const priorArtifact = approvalArtifacts.get(artifactFile.path);
    let artifactReuse;
    if (priorArtifact === undefined) {
      if (approval.artifactReuse !== undefined) {
        throw new CertificationError("APPROVAL_ARTIFACT_REUSE_INVALID", `${name} declares artifactReuse for a path that is not shared`);
      }
      registerManifestArtifact(artifactPaths, artifactFile.path, `${name} approval artifact`);
      approvalArtifacts.set(artifactFile.path, { approvalName: name, sha256: artifactSha256 });
    } else {
      const reuse = plainObject(approval.artifactReuse, `${name}.artifactReuse`);
      if (reuse.withApproval !== priorArtifact.approvalName || artifactSha256 !== priorArtifact.sha256) {
        throw new CertificationError("APPROVAL_ARTIFACT_REUSE_INVALID", `${name} shared artifact must name the prior approval and use the identical digest`);
      }
      artifactReuse = {
        withApproval: reuse.withApproval,
        justification: nonEmptyText(reuse.justification, `${name}.artifactReuse.justification`, 500),
      };
      if (artifactReuse.justification.length < 20) {
        throw new CertificationError("APPROVAL_ARTIFACT_REUSE_INVALID", `${name} shared artifact requires a substantive justification`);
      }
    }
    const approvalId = identifier(approval.approvalId, `${name}.approvalId`);
    const authority = nonEmptyText(approval.authority, `${name}.authority`, 300);
    const issuer = identifier(approval.issuer, `${name}.issuer`);
    const evidenceId = identifier(approval.evidenceId, `${name}.evidenceId`);
    let approvalContract;
    try {
      approvalContract = validateReleaseApprovalArtifact(artifactFile.bytes, {
        approvalName: name,
        approvalId,
        authority,
        issuer,
        tenantId,
        launchId,
        repositoryCommit: expectedCommit,
        sbomSha256: record.sbomDigest,
        decision,
        approvedAt: approvedAt.toISOString(),
        expiresAt: expiresAt?.toISOString(),
        releaseSubject,
      });
    } catch (error) {
      if (error instanceof EvidenceContractError) {
        throw new CertificationError(error.code, error.message);
      }
      throw error;
    }
    approvals[name] = {
      approvalId,
      authority,
      issuer,
      evidenceId,
      authorityRole: approvalContract.authorityRole,
      subject: approvalContract.subject,
      artifact: { path: artifactPath, resolvedPath: artifactFile.path, sha256: artifactSha256 },
      ...(artifactReuse === undefined ? {} : { artifactReuse }),
      decision,
      approvedAt: approvedAt.toISOString(),
      ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
    };
  }
  const approvalIds = Object.values(approvals).map((approval) => approval.approvalId);
  if (new Set(approvalIds).size !== approvalIds.length) {
    throw new CertificationError("DUPLICATE_APPROVAL_ID", "Release approval IDs must be unique");
  }
  approvals.productionChangeApproval.approverSignatures = validateProductionChangeApproverEvidence({
    root,
    artifactPaths,
    trustedKeys,
    tenantId,
    launchId,
    repositoryCommit: expectedCommit,
    releaseSubject,
    approval: approvals.productionChangeApproval,
    now,
  });
  if (!sameStringSet(
    record.changeApproverEvidenceIds,
    approvals.productionChangeApproval.approverSignatures.map((entry) => entry.evidenceId),
  )) {
    throw new CertificationError("B127_CHANGE_APPROVER_BINDING_MISMATCH", "The B127 record does not bind the exact independently signed change approver evidence IDs");
  }

  if (changeApprovalId !== approvals.productionChangeApproval.approvalId) {
    throw new CertificationError("GO_LIVE_CHANGE_APPROVAL_MISMATCH", "The go-live window is not bound to the production change approval");
  }

  const handoffValue = plainObject(manifest.operationsHandoff, "manifest operationsHandoff");
  requireExactObjectKeys(handoffValue, [
    "handoffId", "status", "acceptedAt", "acceptedBy", "runbookVersion",
    "onCallScheduleVersion", "supportPlanVersion", "artifact",
  ], "manifest operationsHandoff");
  if (handoffValue.status !== "accepted") {
    throw blocked("OPERATIONS_HANDOFF_INCOMPLETE", "Production operations must accept the release handoff before B127 certification");
  }
  const acceptedAt = canonicalTimestamp(handoffValue.acceptedAt, "manifest operationsHandoff.acceptedAt");
  if (acceptedAt > generatedAt) {
    throw new CertificationError("OPERATIONS_HANDOFF_AFTER_MANIFEST", "Operations handoff acceptance occurred after the release manifest was frozen");
  }
  const handoffId = identifier(handoffValue.handoffId, "manifest operationsHandoff.handoffId");
  const acceptedBy = identifier(handoffValue.acceptedBy, "manifest operationsHandoff.acceptedBy");
  const runbookVersion = releaseVersion(handoffValue.runbookVersion, "manifest operationsHandoff.runbookVersion");
  const onCallScheduleVersion = releaseVersion(handoffValue.onCallScheduleVersion, "manifest operationsHandoff.onCallScheduleVersion");
  const supportPlanVersion = releaseVersion(handoffValue.supportPlanVersion, "manifest operationsHandoff.supportPlanVersion");
  const handoffArtifactResult = validateManifestArtifact(
    root,
    handoffValue.artifact,
    "operations handoff artifact",
    MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
    artifactPaths,
    "OPERATIONS_HANDOFF_ARTIFACT_DIGEST_MISMATCH",
  );
  const expectedHandoffDocument = {
    schemaVersion: "ltm.operations-handoff.v1",
    releaseId: launchId,
    tenantId,
    launchId,
    deploymentId: releaseSubject.deploymentId,
    repositoryCommit,
    componentSetSha256,
    handoffId,
    status: "accepted",
    acceptedAt: acceptedAt.toISOString(),
    acceptedBy,
    runbookVersion,
    onCallScheduleVersion,
    supportPlanVersion,
  };
  const handoffDocument = parseJsonObject(
    handoffArtifactResult.file.bytes.toString("utf8"),
    "operations handoff artifact",
  );
  if (canonicalJson(handoffDocument) !== canonicalJson(expectedHandoffDocument)) {
    throw new CertificationError(
      "OPERATIONS_HANDOFF_ARTIFACT_CONTENT_MISMATCH",
      "The operations handoff artifact does not exactly bind the accepted release, runbook, on-call schedule, and support plan",
    );
  }
  const operationsHandoff = {
    handoffId,
    status: "accepted",
    acceptedAt: acceptedAt.toISOString(),
    acceptedBy,
    runbookVersion,
    onCallScheduleVersion,
    supportPlanVersion,
    artifact: handoffArtifactResult.artifact,
  };

  if (!Array.isArray(manifest.exceptions) || manifest.exceptions.length > 50) {
    throw new CertificationError("RELEASE_EXCEPTIONS_INVALID", "manifest exceptions must be an array of at most 50 approved non-critical exceptions");
  }
  const exceptionIds = new Set();
  const exceptions = manifest.exceptions.map((value, index) => {
    const exception = plainObject(value, `manifest exceptions[${index}]`);
    const exceptionId = identifier(exception.exceptionId, `manifest exceptions[${index}].exceptionId`);
    if (exceptionIds.has(exceptionId)) throw new CertificationError("RELEASE_EXCEPTION_DUPLICATE", `Release exception ${exceptionId} is duplicated`);
    exceptionIds.add(exceptionId);
    if (exception.status !== "approved" || !["low", "medium"].includes(exception.severity)) {
      throw blocked("RELEASE_EXCEPTION_NOT_APPROVED", `Release exception ${exceptionId} is not an approved low or medium risk acceptance`);
    }
    const expiresAt = canonicalTimestamp(exception.expiresAt, `manifest exceptions[${index}].expiresAt`);
    if (expiresAt.getTime() <= now.getTime()) throw blocked("RELEASE_EXCEPTION_EXPIRED", `Release exception ${exceptionId} is expired`);
    const approvalId = identifier(exception.approvalId, `manifest exceptions[${index}].approvalId`);
    if (!approvalIds.includes(approvalId)) {
      throw new CertificationError("RELEASE_EXCEPTION_APPROVAL_MISMATCH", `Release exception ${exceptionId} is not bound to a required release approval`);
    }
    return {
      exceptionId,
      status: "approved",
      severity: exception.severity,
      scope: nonEmptyText(exception.scope, `manifest exceptions[${index}].scope`, 500),
      mitigation: nonEmptyText(exception.mitigation, `manifest exceptions[${index}].mitigation`, 2_000),
      riskOwner: identifier(exception.riskOwner, `manifest exceptions[${index}].riskOwner`),
      approvalId,
      expiresAt: expiresAt.toISOString(),
      artifact: validateManifestArtifact(
        root,
        exception.artifact,
        `release exception ${exceptionId} artifact`,
        MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
        artifactPaths,
        "RELEASE_EXCEPTION_ARTIFACT_DIGEST_MISMATCH",
      ).artifact,
    };
  });

  return {
    ...manifest,
    generatedAt: generatedAt.toISOString(),
    repositoryCommit,
    artifactCommit,
    sbom: { ...sbomResult.artifact, format: sbom.format, file: sbomResult.file },
    selectedProfile,
    componentVersions,
    componentSetSha256,
    releaseSubject,
    policyAuthority: {
      mediaAuthorityArtifact: releaseSubjectValidation.mediaAuthorityArtifact,
    },
    batchReports,
    b126Certification,
    rollout,
    approvals,
    goLive,
    operationsHandoff,
    exceptions,
  };
}

function validateManifestReleaseSubject(value, {
  root,
  generatedAt,
  now,
  expectedCommit,
  selectedProfile,
  componentVersions,
  componentSetSha256,
  sbom,
  goLive,
  artifactPaths,
  trustedKeys,
  rollout,
}) {
  const controlled = plainObject(value, "manifest releaseSubject");
  requireExactObjectKeys(controlled, [
    "schemaVersion", "deploymentId", "targetBaseUrl", "workloadImages", "requiredProviderIds",
    "secretReferences", "forcedRlsTables", "databaseUrlReference", "consentPolicyCatalogSha256",
    "mediaLifecycleCatalogSha256", "mediaSafetyPolicySha256", "guardrailPolicySha256", "waveObservationSetSha256",
    "rollbackForwardDrillSha256", "mediaAuthorityArtifact", "legal", "accessibility",
    "applications", "penetrationTest", "disasterRecovery", "supplyChain",
  ], "manifest releaseSubject");
  if (controlled.schemaVersion !== "ltm.production-release-subject-config.v1") {
    throw new CertificationError("RELEASE_SUBJECT_SCHEMA_INVALID", "manifest releaseSubject schemaVersion is unsupported");
  }

  const lockfile = readRootRelativeFile(root, "pnpm-lock.yaml", "release lockfile", MAX_RELEASE_CONTROL_ARTIFACT_BYTES);
  const lockfileSha256 = sha256Bytes(lockfile.bytes);
  const migrationManifest = validateLocalMigrationManifest(root);

  const workloadImagesValue = Array.isArray(controlled.workloadImages) ? controlled.workloadImages : [];
  if (workloadImagesValue.length !== REQUIRED_WORKLOAD_ROLES.length) throw new CertificationError("RELEASE_WORKLOAD_IMAGES_INVALID", `releaseSubject requires exactly ${REQUIRED_WORKLOAD_ROLES.length} workload images`);
  const workloadImages = workloadImagesValue.map((entryValue, index) => {
    const entry = plainObject(entryValue, `manifest releaseSubject.workloadImages[${index}]`);
    requireExactObjectKeys(entry, ["role", "digest"], `manifest releaseSubject.workloadImages[${index}]`);
    const role = identifier(entry.role, `manifest releaseSubject.workloadImages[${index}].role`);
    if (typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) throw new CertificationError("RELEASE_WORKLOAD_IMAGE_DIGEST_INVALID", `${role} image must use an immutable sha256 digest`);
    return { role, digest: entry.digest };
  }).sort((left, right) => left.role.localeCompare(right.role));

  const requiredProviderIds = sortedIdentifiers(controlled.requiredProviderIds, "manifest releaseSubject.requiredProviderIds", 1, 100);
  const secretReferences = sortedVisibleStrings(controlled.secretReferences, "manifest releaseSubject.secretReferences", 1, 200);
  const forcedRlsTables = sortedIdentifiers(controlled.forcedRlsTables, "manifest releaseSubject.forcedRlsTables", 1, 200);
  if (!sameStringSet(forcedRlsTables, REQUIRED_SCHEMA7_FORCE_RLS_TABLES)) {
    throw new CertificationError("RELEASE_FORCE_RLS_TABLES_INVALID", "releaseSubject forcedRlsTables must exactly equal the schema 7 runtime tenant-table set");
  }
  const databaseUrlReference = nonEmptyText(controlled.databaseUrlReference, "manifest releaseSubject.databaseUrlReference", 512);
  const consentPolicyCatalogSha256 = exactSha256(
    controlled.consentPolicyCatalogSha256,
    "manifest releaseSubject.consentPolicyCatalogSha256",
  );
  const mediaLifecycleCatalogSha256 = exactSha256(
    controlled.mediaLifecycleCatalogSha256,
    "manifest releaseSubject.mediaLifecycleCatalogSha256",
  );
  const mediaSafetyPolicySha256 = exactSha256(
    controlled.mediaSafetyPolicySha256,
    "manifest releaseSubject.mediaSafetyPolicySha256",
  );
  const guardrailPolicySha256 = exactSha256(
    controlled.guardrailPolicySha256,
    "manifest releaseSubject.guardrailPolicySha256",
  );
  const waveObservationSetSha256 = exactSha256(
    controlled.waveObservationSetSha256,
    "manifest releaseSubject.waveObservationSetSha256",
  );
  const rollbackForwardDrillSha256 = exactSha256(
    controlled.rollbackForwardDrillSha256,
    "manifest releaseSubject.rollbackForwardDrillSha256",
  );
  if (
    guardrailPolicySha256 !== rollout.guardrailPolicyArtifact.sha256 ||
    waveObservationSetSha256 !== rollout.waveObservationSetSha256 ||
    rollbackForwardDrillSha256 !== rollout.rollbackForwardDrillArtifact.sha256
  ) {
    throw new CertificationError(
      "RELEASE_CONTROL_ARTIFACT_BINDING_MISMATCH",
      "Release subject does not bind the exact guardrail policy, wave-observation set, and rollback-forward drill artifacts",
    );
  }
  const mediaAuthorityArtifact = validateManifestArtifact(
    root,
    controlled.mediaAuthorityArtifact,
    "production media authority projection",
    MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
    artifactPaths,
    "MEDIA_AUTHORITY_ARTIFACT_DIGEST_MISMATCH",
  );
  validateMediaAuthorityArtifact(mediaAuthorityArtifact.file.bytes, {
    mediaLifecycleCatalogSha256,
    mediaSafetyPolicySha256,
    guardrailPolicySha256,
    generatedAt,
    now,
  });

  const legalValue = plainObject(controlled.legal, "manifest releaseSubject.legal");
  requireExactObjectKeys(legalValue, ["legalEntityId", "jurisdictions"], "manifest releaseSubject.legal");
  const legal = {
    legalEntityId: identifier(legalValue.legalEntityId, "manifest releaseSubject.legal.legalEntityId"),
    jurisdictions: sortedIdentifiers(legalValue.jurisdictions, "manifest releaseSubject.legal.jurisdictions", 1, 100),
  };

  const accessibilityValue = plainObject(controlled.accessibility, "manifest releaseSubject.accessibility");
  requireExactObjectKeys(accessibilityValue, ["standard", "platforms", "browsers", "assistiveTechnologies", "journeys"], "manifest releaseSubject.accessibility");
  const accessibility = {
    standard: nonEmptyText(accessibilityValue.standard, "manifest releaseSubject.accessibility.standard", 64),
    platforms: sortedIdentifiers(accessibilityValue.platforms, "manifest releaseSubject.accessibility.platforms", 1, 20),
    browsers: sortedIdentifiers(accessibilityValue.browsers, "manifest releaseSubject.accessibility.browsers", 1, 20),
    assistiveTechnologies: sortedIdentifiers(accessibilityValue.assistiveTechnologies, "manifest releaseSubject.accessibility.assistiveTechnologies", 1, 20),
    journeys: sortedIdentifiers(accessibilityValue.journeys, "manifest releaseSubject.accessibility.journeys", 1, 100),
  };

  const applicationsValue = plainObject(controlled.applications, "manifest releaseSubject.applications");
  requireExactObjectKeys(applicationsValue, ["appleAppStoreDecision", "googlePlayDecision", "wechatMiniProgramDecision"], "manifest releaseSubject.applications");
  const applicationComponents = {
    appleAppStoreDecision: ["apple-app-store", "mobileIos"],
    googlePlayDecision: ["google-play", "mobileAndroid"],
    wechatMiniProgramDecision: ["wechat-mini-program", "wechatMiniProgram"],
  };
  const applications = Object.fromEntries(Object.entries(applicationComponents).map(([name, [store, componentName]]) => {
    const entry = plainObject(applicationsValue[name], `manifest releaseSubject.applications.${name}`);
    requireExactObjectKeys(entry, ["applicationId", "accountId"], `manifest releaseSubject.applications.${name}`);
    return [name, {
      store,
      applicationId: nonEmptyText(entry.applicationId, `manifest releaseSubject.applications.${name}.applicationId`, 256),
      accountId: nonEmptyText(entry.accountId, `manifest releaseSubject.applications.${name}.accountId`, 256),
      version: componentVersions[componentName].version,
      buildSha256: componentVersions[componentName].artifact.sha256,
    }];
  }));

  const penetrationValue = plainObject(controlled.penetrationTest, "manifest releaseSubject.penetrationTest");
  requireExactObjectKeys(penetrationValue, ["reportArtifact", "findingRegistryArtifact"], "manifest releaseSubject.penetrationTest");
  const pentestReport = validateManifestArtifact(root, penetrationValue.reportArtifact, "independent pentest report", MAX_RELEASE_CONTROL_ARTIFACT_BYTES, artifactPaths, "PENTEST_REPORT_DIGEST_MISMATCH");
  const findingRegistry = validateManifestArtifact(root, penetrationValue.findingRegistryArtifact, "pentest finding registry", MAX_RELEASE_CONTROL_ARTIFACT_BYTES, artifactPaths, "PENTEST_FINDING_REGISTRY_DIGEST_MISMATCH");

  const drValue = plainObject(controlled.disasterRecovery, "manifest releaseSubject.disasterRecovery");
  requireExactObjectKeys(drValue, ["reportArtifact", "sourceRegion", "failoverRegion", "schemaVersion", "targetRtoSeconds", "targetRpoSeconds"], "manifest releaseSubject.disasterRecovery");
  const drReport = validateManifestArtifact(root, drValue.reportArtifact, "disaster recovery report", MAX_RELEASE_CONTROL_ARTIFACT_BYTES, artifactPaths, "DR_REPORT_DIGEST_MISMATCH");

  const supplyValue = plainObject(controlled.supplyChain, "manifest releaseSubject.supplyChain");
  requireExactObjectKeys(supplyValue, ["bundleArtifact", "trustedKeyId"], "manifest releaseSubject.supplyChain");
  const bundleArtifact = validateManifestArtifact(root, supplyValue.bundleArtifact, "production supply-chain bundle", MAX_SBOM_BYTES, artifactPaths, "SUPPLY_CHAIN_BUNDLE_DIGEST_MISMATCH");
  const trustedKeyId = identifier(supplyValue.trustedKeyId, "manifest releaseSubject.supplyChain.trustedKeyId");
  const supplyKey = trustedKeys.find((candidate) => candidate.keyId === trustedKeyId && candidate.provider.startsWith("supply-chain:") && candidate.authorityRoles.includes(SUPPLY_CHAIN_AUTHORITY_ROLE) && scopeAllowed(candidate.allowedScopes, "ltm-supply-chain:production"));
  if (supplyKey === undefined) throw blocked("SUPPLY_CHAIN_TRUST_KEY_MISSING", "Production supply-chain signer is not enrolled for the required authority role");
  let bundle;
  try {
    bundle = parseJsonObject(bundleArtifact.file.bytes.toString("utf8"), "production supply-chain bundle");
    verifySupplyChainBundle(bundle, {
      requiredTrustTier: "production",
      trustedKeyIds: [trustedKeyId],
      publicKeyPem: supplyKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
  } catch (error) {
    throw new CertificationError("SUPPLY_CHAIN_ATTESTATION_INVALID", `Production supply-chain attestation failed verification: ${error instanceof Error ? error.message : "invalid bundle"}`);
  }
  if (bundle.attestation?.claims?.sourceRevision !== expectedCommit || bundle.attestation?.claims?.lockfileSha256 !== lockfileSha256) {
    throw new CertificationError("SUPPLY_CHAIN_RELEASE_BINDING_MISMATCH", "Supply-chain source revision or lockfile digest does not match the checked-out release");
  }
  const selectedSbom = sbom.format === "spdx-json" ? bundle.spdx : bundle.cycloneDx;
  const manifestSbom = parseJsonObject(sbom.file.bytes.toString("utf8"), "release SBOM");
  if (canonicalJson(selectedSbom) !== canonicalJson(manifestSbom)) throw new CertificationError("SBOM_SUPPLY_CHAIN_MISMATCH", "Release SBOM is not the document signed by the production supply-chain bundle");
  const suppliedFiles = new Map((bundle.artifactManifest?.files ?? []).map((entry) => [entry.path, entry.sha256]));
  for (const component of Object.values(componentVersions)) {
    if (suppliedFiles.get(component.artifact.path) !== component.artifact.sha256) throw new CertificationError("SUPPLY_CHAIN_COMPONENT_SET_MISMATCH", "Supply-chain artifact manifest does not cover every exact B127 component artifact");
  }
  const provenanceSha256 = exactSha256(bundle.attestation.claims.documents?.provenance?.sha256, "supply-chain provenance sha256");

  const candidate = {
    schemaVersion: "ltm.production-release-subject.v1",
    deploymentId: identifier(controlled.deploymentId, "manifest releaseSubject.deploymentId"),
    targetBaseUrl: nonEmptyText(controlled.targetBaseUrl, "manifest releaseSubject.targetBaseUrl", 2_048),
    repositoryCommit: expectedCommit,
    profileVersion: selectedProfile.version,
    componentSetSha256,
    lockfileSha256,
    migrationManifestSha256: migrationManifest.sha256,
    consentPolicyCatalogSha256,
    mediaLifecycleCatalogSha256,
    mediaSafetyPolicySha256,
    guardrailPolicySha256,
    waveObservationSetSha256,
    rollbackForwardDrillSha256,
    workloadImages,
    requiredProviderIds,
    secretReferences,
    forcedRlsTables,
    databaseUrlReference,
    legal,
    accessibility,
    applications,
    penetrationTest: {
      targetOrigin: controlled.targetBaseUrl,
      reportArtifactSha256: pentestReport.artifact.sha256,
      findingRegistrySha256: findingRegistry.artifact.sha256,
    },
    disasterRecovery: {
      deploymentId: controlled.deploymentId,
      reportArtifactSha256: drReport.artifact.sha256,
      sourceRegion: identifier(drValue.sourceRegion, "manifest releaseSubject.disasterRecovery.sourceRegion"),
      failoverRegion: identifier(drValue.failoverRegion, "manifest releaseSubject.disasterRecovery.failoverRegion"),
      schemaVersion: nonEmptyText(drValue.schemaVersion, "manifest releaseSubject.disasterRecovery.schemaVersion", 32),
      targetRtoSeconds: integerInRange(drValue.targetRtoSeconds, "manifest releaseSubject.disasterRecovery.targetRtoSeconds", 1, 604_800),
      targetRpoSeconds: integerInRange(drValue.targetRpoSeconds, "manifest releaseSubject.disasterRecovery.targetRpoSeconds", 1, 604_800),
    },
    goLive: { windowStart: goLive.windowStart, windowEnd: goLive.windowEnd, scheduledAt: goLive.scheduledAt },
    supplyChain: {
      bundleSha256: bundleArtifact.artifact.sha256,
      provenanceSha256,
      trustKeyId: trustedKeyId,
    },
  };
  try {
    return {
      subject: validateProductionReleaseSubject(candidate),
      mediaAuthorityArtifact: mediaAuthorityArtifact.artifact,
    };
  } catch (error) {
    if (error instanceof EvidenceContractError) throw new CertificationError(error.code, error.message);
    throw error;
  }
}

function validateMediaAuthorityArtifact(bytes, {
  mediaLifecycleCatalogSha256,
  mediaSafetyPolicySha256,
  generatedAt,
  now,
}) {
  let authority;
  try {
    authority = parseJsonObject(bytes.toString("utf8"), "production media authority projection");
    requireExactObjectKeys(authority, [
      "schemaVersion", "mediaLifecycleCatalogSha256", "mediaSafetyPolicySha256", "lifecycleIssuer",
      "lifecycleEnvironment", "lifecycleExpiresAt", "scannerProvider", "scannerPolicyId",
      "scannerModelVersion", "scannerKeyId", "scannerEnvironment",
    ], "production media authority projection");
  } catch (error) {
    throw new CertificationError(
      "MEDIA_AUTHORITY_ARTIFACT_INVALID",
      `Production media authority projection is not a closed valid document: ${error instanceof Error ? error.message : "invalid artifact"}`,
    );
  }
  if (authority.schemaVersion !== "ltm.media-authority.v1") {
    throw new CertificationError("MEDIA_AUTHORITY_ARTIFACT_INVALID", "Production media authority projection schemaVersion is unsupported");
  }
  if (
    exactSha256(authority.mediaLifecycleCatalogSha256, "media authority mediaLifecycleCatalogSha256") !== mediaLifecycleCatalogSha256 ||
    exactSha256(authority.mediaSafetyPolicySha256, "media authority mediaSafetyPolicySha256") !== mediaSafetyPolicySha256
  ) {
    throw new CertificationError("MEDIA_AUTHORITY_BINDING_MISMATCH", "Production media authority projection does not match the controlled release policy digests");
  }
  identifier(authority.lifecycleIssuer, "media authority lifecycleIssuer");
  identifier(authority.scannerProvider, "media authority scannerProvider");
  identifier(authority.scannerPolicyId, "media authority scannerPolicyId");
  releaseVersion(authority.scannerModelVersion, "media authority scannerModelVersion");
  identifier(authority.scannerKeyId, "media authority scannerKeyId");
  if (authority.lifecycleEnvironment !== "production" || authority.scannerEnvironment !== "production") {
    throw new CertificationError("MEDIA_AUTHORITY_ENVIRONMENT_INVALID", "Production media authority projection must bind both authorities to production");
  }
  const expiresAt = canonicalTimestamp(authority.lifecycleExpiresAt, "media authority lifecycleExpiresAt");
  if (expiresAt <= generatedAt || expiresAt <= now) {
    throw blocked("MEDIA_AUTHORITY_EXPIRED", "Production media lifecycle authority is expired at manifest verification time");
  }
  return authority;
}

function validateLocalMigrationManifest(root) {
  const relativeManifestPath = "infra/postgres/migrations/manifest.json";
  const file = readRootRelativeFile(root, relativeManifestPath, "PostgreSQL migration manifest", MAX_RELEASE_CONTROL_ARTIFACT_BYTES);
  const manifest = parseJsonObject(file.bytes.toString("utf8"), "PostgreSQL migration manifest");
  requireExactObjectKeys(manifest, ["schemaVersion", "database", "runtimeSchemaVersion", "migrations"], "PostgreSQL migration manifest");
  if (manifest.schemaVersion !== "ltm.postgres-migration-manifest.v1" || manifest.database !== "postgresql" || manifest.runtimeSchemaVersion !== "7" || !Array.isArray(manifest.migrations) || manifest.migrations.length !== REQUIRED_SCHEMA7_MIGRATIONS.length) {
    throw new CertificationError("MIGRATION_MANIFEST_INVALID", "PostgreSQL migration manifest identity or migration set is invalid");
  }
  const ids = new Set();
  const paths = new Set();
  for (const [index, value] of manifest.migrations.entries()) {
    const migration = plainObject(value, `PostgreSQL migration manifest.migrations[${index}]`);
    requireExactObjectKeys(migration, ["id", "path", "sha256"], `PostgreSQL migration manifest.migrations[${index}]`);
    const id = identifier(migration.id, `PostgreSQL migration manifest.migrations[${index}].id`);
    const expected = REQUIRED_SCHEMA7_MIGRATIONS[index];
    if (id !== expected.id || migration.path !== expected.path) {
      throw new CertificationError("MIGRATION_MANIFEST_INVALID", "PostgreSQL schema 7 migration IDs and paths must exactly equal the controlled 001..007 sequence");
    }
    if (typeof migration.path !== "string" || !/^[0-9]{3}_[A-Za-z0-9._-]+\.sql$/.test(migration.path)) throw new CertificationError("MIGRATION_PATH_INVALID", `Migration ${id} path is invalid`);
    const declared = exactSha256(migration.sha256, `PostgreSQL migration ${id} sha256`);
    if (ids.has(id) || paths.has(migration.path)) throw new CertificationError("MIGRATION_MANIFEST_DUPLICATE", `Migration ${id} is duplicated`);
    ids.add(id); paths.add(migration.path);
    const migrationFile = readRootRelativeFile(root, `infra/postgres/migrations/${migration.path}`, `PostgreSQL migration ${id}`, MAX_RELEASE_CONTROL_ARTIFACT_BYTES);
    if (sha256Bytes(migrationFile.bytes) !== declared) throw new CertificationError("MIGRATION_DRIFT_DETECTED", `Migration ${id} bytes do not match the local manifest`);
  }
  return { sha256: sha256Bytes(file.bytes), count: manifest.migrations.length };
}

function sortedIdentifiers(value, label, minimum, maximum) {
  return stringArray(value, label, minimum, maximum).map((item) => identifier(item, label)).sort((left, right) => left.localeCompare(right));
}

function sortedVisibleStrings(value, label, minimum, maximum) {
  return [...stringArray(value, label, minimum, maximum)].sort((left, right) => left.localeCompare(right));
}

function validateB126Certificate(recordEnvelope, manifestReference, { tenantId, manifestGeneratedAt }) {
  if (recordEnvelope === undefined || recordEnvelope === null || typeof recordEnvelope !== "object") {
    throw blocked("B126_CERTIFICATE_NOT_FOUND", "The B126 prerequisite certificate was not returned by the evidence source");
  }
  if (
    recordEnvelope.tenantId !== tenantId ||
    recordEnvelope.collection !== "capability.launching-complete-commercial-product" ||
    recordEnvelope.id !== manifestReference.recordId
  ) {
    throw new CertificationError("B126_CERTIFICATE_RECORD_MISMATCH", "The B126 certificate record identity does not match the release manifest");
  }
  const data = plainObject(recordEnvelope.data, "B126 certificate data");
  for (const [field, value] of Object.entries({
    batchId: "B126",
    operation: "certifyCommercialE2e",
    operationMode: "attestation",
    executionState: "evidence_persisted",
    environment: "production_canary",
    state: "certified_for_staged_launch",
  })) {
    if (data[field] !== value) throw blocked("B126_CERTIFICATE_INCOMPLETE", `B126 ${field} is not ${value}`);
  }
  const certificationId = identifier(data.certificationId, "B126 certificationId");
  const auditorProviderId = identifier(data.auditorProviderId, "B126 auditorProviderId");
  const scenarioArtifactSha256 = exactSha256(data.scenarioArtifactSha256, "B126 scenarioArtifactSha256");
  if (
    certificationId !== manifestReference.certificationId ||
    auditorProviderId !== manifestReference.auditorProviderId ||
    scenarioArtifactSha256 !== manifestReference.artifact.sha256
  ) {
    throw new CertificationError("B126_CERTIFICATE_BINDING_MISMATCH", "The B126 certificate identifier, auditor, or artifact does not match the release manifest");
  }
  const recordCreatedAt = canonicalTimestamp(recordEnvelope.createdAt, "B126 record createdAt");
  if (recordCreatedAt > canonicalTimestamp(manifestGeneratedAt, "release manifest generatedAt")) {
    throw new CertificationError("B126_CERTIFICATE_AFTER_MANIFEST", "B126 was certified after the release manifest was frozen");
  }
  const entrypoints = stringArray(data.entrypoints, "B126 entrypoints", 4, 100);
  requireMembers(entrypoints, ["web", "api", "mobile", "wechat_mini_program"], "B126 entrypoints");
  const scenarios = stringArray(data.scenarios, "B126 scenarios", 8, 100);
  requireMembers(scenarios, ["consent", "generation", "payment", "refund", "physical_fulfillment", "support", "finance_close", "deletion"], "B126 scenarios");
  const deletionProofTargets = stringArray(data.deletionProofTargets, "B126 deletionProofTargets", 5, 100);
  requireMembers(deletionProofTargets, ["connector", "cdn", "vendor", "warehouse", "application"], "B126 deletionProofTargets");
  const financialTotal = integerInRange(data.financialControlTotalMinor, "B126 financialControlTotalMinor", 0, Number.MAX_SAFE_INTEGER);
  const ledgerTotal = integerInRange(data.ledgerControlTotalMinor, "B126 ledgerControlTotalMinor", 0, Number.MAX_SAFE_INTEGER);
  if (financialTotal !== ledgerTotal || data.criticalFailures !== 0) {
    throw blocked("B126_CONTROL_TOTAL_FAILED", "B126 financial/ledger reconciliation or critical scenario controls did not pass");
  }
  identifier(data.entitlementReconciliationId, "B126 entitlementReconciliationId");
  const externalEvidenceIds = stringArray(data.externalEvidenceIds, "B126 externalEvidenceIds", 5, 100)
    .map((value) => identifier(value, "B126 evidenceId"));
  if (!sameStringSet(externalEvidenceIds, manifestReference.evidenceIds)) {
    throw new CertificationError("B126_EVIDENCE_REFERENCE_MISMATCH", "The B126 evidence IDs do not exactly match the release manifest");
  }
  const evidenceScope = nonEmptyText(data.evidenceScope, "B126 evidenceScope", 512);
  const expectedScope = b126EvidenceScope({
    tenantId,
    provider: `e2e-auditor:${auditorProviderId}`,
    artifactSha256: scenarioArtifactSha256,
    certificationId,
  });
  if (evidenceScope !== expectedScope) {
    throw new CertificationError("B126_SCOPE_MISMATCH", "The B126 certificate evidence scope is not bound to the exact production prerequisite");
  }
  return {
    ...data,
    certificationId,
    auditorProviderId,
    scenarioArtifactSha256,
    externalEvidenceIds,
    evidenceScope,
  };
}

function validateManifestArtifact(root, value, label, maximumBytes, artifactPaths, digestMismatchCode) {
  const artifact = plainObject(value, `${label} reference`);
  const path = canonicalArtifactPath(root, artifact.path, `${label} path`);
  const sha256 = exactSha256(artifact.sha256, `${label} sha256`);
  const file = readRootRelativeFile(root, path, label, maximumBytes);
  if (sha256Bytes(file.bytes) !== sha256) {
    throw new CertificationError(digestMismatchCode, `${label} bytes do not match the release manifest digest`);
  }
  registerManifestArtifact(artifactPaths, file.path, label);
  return { artifact: { path, resolvedPath: file.path, sha256 }, file };
}

function registerManifestArtifact(artifactPaths, resolvedPath, label) {
  const prior = artifactPaths.get(resolvedPath);
  if (prior !== undefined) {
    throw new CertificationError("RELEASE_ARTIFACT_PATH_REUSED", `${label} reuses the same file as ${prior}`);
  }
  artifactPaths.set(resolvedPath, label);
}

function canonicalArtifactPath(root, value, label) {
  return relative(root, resolveInsideRoot(root, safeRelativePath(value, label), label));
}

function componentVersionsForDigest(components) {
  return Object.fromEntries(REQUIRED_COMPONENT_VERSIONS.map((name) => [name, {
    version: components[name].version,
    artifact: { path: components[name].artifact.path, sha256: components[name].artifact.sha256 },
  }]));
}

function validateCompletedWaves(value, {
  root,
  artifactPaths,
  globalWaveStartedAt,
  now,
  tenantId,
  launchId,
  deploymentId,
  repositoryCommit,
  componentSetSha256,
  automaticPausePolicyVersion,
  guardrailPolicy,
  guardrailPolicySha256,
  trustedKeys,
}) {
  const expectedWaves = ["internal", "pilot", "consumer_canary", "partner", "regional"];
  if (!Array.isArray(value) || value.length !== expectedWaves.length) {
    throw blocked("PRIOR_WAVE_EVIDENCE_INCOMPLETE", "The release manifest must contain every completed pre-global wave exactly once");
  }
  let priorCompletedAt;
  let priorPercent = 0;
  const completed = value.map((entryValue, index) => {
    const entry = plainObject(entryValue, `manifest rollout.completedWaves[${index}]`);
    requireExactObjectKeys(entry, [
      "wave", "status", "rolloutPercent", "startedAt", "completedAt",
      "minimumObservationSeconds", "observedSeconds", "guardrailBreaches", "observationArtifact",
    ], `manifest rollout.completedWaves[${index}]`);
    const expectedWave = expectedWaves[index];
    if (entry.wave !== expectedWave || entry.status !== "passed") {
      throw blocked("PRIOR_WAVE_NOT_PASSED", `Release wave ${expectedWave} is missing or not passed`);
    }
    const rolloutPercent = integerInRange(entry.rolloutPercent, `${expectedWave}.rolloutPercent`, 1, 99);
    if (rolloutPercent <= priorPercent) {
      throw new CertificationError("PRIOR_WAVE_PERCENT_INVALID", "Pre-global rollout percentages must increase monotonically");
    }
    const startedAt = canonicalTimestamp(entry.startedAt, `${expectedWave}.startedAt`);
    const completedAt = canonicalTimestamp(entry.completedAt, `${expectedWave}.completedAt`);
    const minimumObservationSeconds = integerInRange(entry.minimumObservationSeconds, `${expectedWave}.minimumObservationSeconds`, 3_600, 30 * 24 * 60 * 60);
    const observedSeconds = integerInRange(entry.observedSeconds, `${expectedWave}.observedSeconds`, minimumObservationSeconds, 60 * 24 * 60 * 60);
    if (
      completedAt <= startedAt ||
      completedAt.getTime() - startedAt.getTime() < observedSeconds * 1_000 ||
      (priorCompletedAt !== undefined && startedAt < priorCompletedAt) ||
      completedAt > globalWaveStartedAt ||
      completedAt.getTime() > now.getTime() + CLOCK_SKEW_MS ||
      entry.guardrailBreaches !== 0
    ) {
      throw blocked("PRIOR_WAVE_OBSERVATION_FAILED", `Release wave ${expectedWave} lacks a complete zero-breach observation period`);
    }
    const observationArtifactResult = validateManifestArtifact(
      root,
      entry.observationArtifact,
      `${expectedWave} typed wave observation`,
      MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
      artifactPaths,
      "PRIOR_WAVE_ARTIFACT_DIGEST_MISMATCH",
    );
    const observation = mapReleaseControlValidation(() => validateRolloutWaveObservation(
      observationArtifactResult.file.bytes,
      {
        tenantId,
        launchId,
        deploymentId,
        repositoryCommit,
        componentSetSha256,
        wave: expectedWave,
        rolloutPercent,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        minimumObservationSeconds,
        observedSeconds,
        automaticPausePolicyVersion,
        guardrailPolicy,
        guardrailPolicySha256,
        readArtifact(reference, label) {
          return validateManifestArtifact(
            root,
            reference,
            `${expectedWave} ${label}`,
            MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
            artifactPaths,
            "WAVE_RAW_EVIDENCE_DIGEST_MISMATCH",
          ).file.bytes;
        },
        verifyAttestation(reference, expectedClaims, label) {
          return verifyControlArtifactAttestation({
            root,
            artifactPaths,
            now,
            trustedKeys,
            reference,
            expectedClaims,
            label,
          });
        },
      },
    ));
    priorCompletedAt = completedAt;
    priorPercent = rolloutPercent;
    return {
      wave: expectedWave,
      status: "passed",
      rolloutPercent,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      minimumObservationSeconds,
      observedSeconds,
      guardrailBreaches: 0,
      observationArtifact: observationArtifactResult.artifact,
      observation,
    };
  });
  validateWaveEvidenceUniqueness(completed);
  return completed;
}

function validateGlobalWaveObservation(reference, {
  root,
  artifactPaths,
  globalWaveStartedAt,
  now,
  tenantId,
  launchId,
  deploymentId,
  repositoryCommit,
  componentSetSha256,
  automaticPausePolicyVersion,
  guardrailPolicy,
  guardrailPolicySha256,
  trustedKeys,
}) {
  const observationArtifactResult = validateManifestArtifact(
    root,
    reference,
    "global typed wave observation",
    MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
    artifactPaths,
    "GLOBAL_WAVE_ARTIFACT_DIGEST_MISMATCH",
  );
  const document = parseJsonObject(
    observationArtifactResult.file.bytes.toString("utf8"),
    "global rollout-wave observation",
  );
  const window = plainObject(document.monitoringWindow, "global rollout-wave observation monitoringWindow");
  const startedAt = canonicalTimestamp(window.startedAt, "global wave startedAt");
  const completedAt = canonicalTimestamp(window.endedAt, "global wave completedAt");
  const minimumObservationSeconds = integerInRange(
    window.minimumObservationSeconds,
    "global wave minimumObservationSeconds",
    3_600,
    30 * 24 * 60 * 60,
  );
  const observedSeconds = integerInRange(
    window.observedSeconds,
    "global wave observedSeconds",
    minimumObservationSeconds,
    60 * 24 * 60 * 60,
  );
  if (
    document.wave !== "global" ||
    document.rolloutPercent !== 100 ||
    startedAt.getTime() !== globalWaveStartedAt.getTime() ||
    completedAt <= startedAt ||
    completedAt.getTime() - startedAt.getTime() < observedSeconds * 1_000 ||
    completedAt > now
  ) {
    throw blocked(
      "GLOBAL_WAVE_OBSERVATION_INCOMPLETE",
      "The global 100 percent wave requires a completed duration-bound observation from its approved start through the current verification time",
    );
  }
  const observation = mapReleaseControlValidation(() => validateRolloutWaveObservation(
    observationArtifactResult.file.bytes,
    {
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      wave: "global",
      rolloutPercent: 100,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      minimumObservationSeconds,
      observedSeconds,
      automaticPausePolicyVersion,
      guardrailPolicy,
      guardrailPolicySha256,
      readArtifact(rawReference, label) {
        return validateManifestArtifact(
          root,
          rawReference,
          `global ${label}`,
          MAX_RELEASE_CONTROL_ARTIFACT_BYTES,
          artifactPaths,
          "WAVE_RAW_EVIDENCE_DIGEST_MISMATCH",
        ).file.bytes;
      },
      verifyAttestation(attestationReference, expectedClaims, label) {
        return verifyControlArtifactAttestation({
          root,
          artifactPaths,
          now,
          trustedKeys,
          reference: attestationReference,
          expectedClaims,
          label: `global ${label}`,
        });
      },
    },
  ));
  return {
    wave: "global",
    status: "passed",
    rolloutPercent: 100,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    minimumObservationSeconds,
    observedSeconds,
    guardrailBreaches: 0,
    observationArtifact: observationArtifactResult.artifact,
    observation,
  };
}

function validateWaveEvidenceUniqueness(completed) {
  const evidenceBindings = completed.flatMap((wave) => wave.observation.evidenceBindings.map((binding) => ({
    ...binding,
    wave: wave.wave,
    startedAt: wave.startedAt,
    completedAt: wave.completedAt,
  })));
  for (const field of ["id", "sha256"]) {
    const seen = new Map();
    for (const binding of evidenceBindings) {
      const prior = seen.get(binding[field]);
      if (prior !== undefined) {
        throw new CertificationError(
          "WAVE_OBSERVATION_EVIDENCE_REUSED",
          `Completed waves ${prior.wave} and ${binding.wave} reuse ${binding.kind} ${field} evidence`,
        );
      }
      seen.set(binding[field], binding);
    }
  }
  const attestedBindings = evidenceBindings.filter((binding) => binding.kind !== "pause_drill");
  for (const field of ["attestationId", "nonce", "signature", "attestationSha256"]) {
    const seen = new Map();
    for (const binding of attestedBindings) {
      if (typeof binding[field] !== "string" || binding[field].length === 0) {
        throw new CertificationError(
          "CONTROL_ARTIFACT_ATTESTATION_MISSING",
          `Completed wave ${binding.wave} ${binding.kind} lacks verified ${field}`,
        );
      }
      const prior = seen.get(binding[field]);
      if (prior !== undefined) {
        throw new CertificationError(
          "CONTROL_ARTIFACT_ATTESTATION_REUSED",
          `Completed waves ${prior.wave} and ${binding.wave} reuse ${binding.kind} ${field}`,
        );
      }
      seen.set(binding[field], binding);
    }
  }
}

function verifyControlArtifactAttestation({
  root,
  artifactPaths,
  now,
  trustedKeys,
  reference,
  expectedClaims,
  label,
}) {
  const artifact = validateManifestArtifact(
    root,
    reference,
    `${label} detached producer attestation`,
    MAX_APPROVAL_ARTIFACT_BYTES,
    artifactPaths,
    "CONTROL_ARTIFACT_ATTESTATION_DIGEST_MISMATCH",
  );
  const document = parseJsonObject(
    artifact.file.bytes.toString("utf8"),
    `${label} detached producer attestation`,
  );
  requireExactObjectKeys(document, [
    "schemaVersion", "attestationId", "nonce", "issuer", "provider", "environment",
    "authorityRole", "algorithm", "keyId", "issuedAt", "expiresAt", "scope", "claims",
    "signature",
  ], `${label} detached producer attestation`);
  if (
    document.schemaVersion !== CONTROL_ARTIFACT_ATTESTATION_SCHEMA_VERSION ||
    document.algorithm !== "Ed25519" ||
    document.environment !== "production"
  ) {
    throw new CertificationError(
      "CONTROL_ARTIFACT_ATTESTATION_CONTRACT_INVALID",
      `${label} detached producer attestation has an unsupported schema, algorithm, or environment`,
    );
  }
  const attestationId = identifier(document.attestationId, `${label} attestationId`);
  const nonce = identifier(document.nonce, `${label} attestation nonce`);
  const issuer = identifier(document.issuer, `${label} attestation issuer`);
  const provider = identifier(document.provider, `${label} attestation provider`);
  const keyId = identifier(document.keyId, `${label} attestation keyId`);
  const authorityRole = identifier(document.authorityRole, `${label} attestation authorityRole`);
  const claims = validateControlArtifactAttestationClaims(document.claims, label);
  const expectedRole = CONTROL_ARTIFACT_AUTHORITY_ROLES[claims.artifactType];
  const providerPrefix = CONTROL_ARTIFACT_PROVIDER_PREFIXES[claims.artifactType];
  const expectedProvider = `${providerPrefix}:${expectedClaims.deploymentId}`;
  if (
    expectedRole === undefined ||
    authorityRole !== expectedRole ||
    provider !== expectedProvider ||
    claims.state !== CONTROL_ARTIFACT_STATES[claims.artifactType]
  ) {
    throw new CertificationError(
      "CONTROL_ARTIFACT_ATTESTATION_AUTHORITY_INVALID",
      `${label} detached producer attestation is not issued by its exact production authority role and provider`,
    );
  }
  const issuedAt = canonicalTimestamp(document.issuedAt, `${label} attestation issuedAt`);
  const expiresAt = canonicalTimestamp(document.expiresAt, `${label} attestation expiresAt`);
  const scope = nonEmptyText(document.scope, `${label} attestation scope`, 512);
  const derivedScope = controlArtifactAttestationScope(claims);
  if (scope !== derivedScope || document.issuedAt !== claims.eventAt) {
    throw new CertificationError(
      "CONTROL_ARTIFACT_ATTESTATION_SCOPE_INVALID",
      `${label} detached producer attestation scope or issuance time is not derived from its exact claims`,
    );
  }
  if (
    issuedAt.getTime() > now.getTime() + CLOCK_SKEW_MS ||
    expiresAt <= issuedAt ||
    expiresAt <= now ||
    expiresAt.getTime() - issuedAt.getTime() > 7 * 24 * 60 * 60_000
  ) {
    throw new CertificationError(
      "CONTROL_ARTIFACT_ATTESTATION_TIME_INVALID",
      `${label} detached producer attestation is future-dated, expired, or has an excessive validity window`,
    );
  }
  const trustedKey = trustedKeys.find((candidate) =>
    candidate.issuer === issuer && candidate.provider === provider && candidate.keyId === keyId,
  );
  if (
    trustedKey === undefined ||
    !sameStringSet(trustedKey.authorityRoles, [authorityRole]) ||
    !sameStringSet(trustedKey.allowedEnvironments, ["production"]) ||
    !trustedKey.allowedScopes.includes(scope) ||
    trustedKey.allowedScopes.some((allowedScope) => allowedScope.includes("*")) ||
    trustedKey.notBefore === undefined ||
    trustedKey.notAfter === undefined
  ) {
    throw blocked(
      "CONTROL_ARTIFACT_ATTESTATION_TRUST_MISSING",
      `${label} producer key is not independently enrolled for its exact role, scope, and production environment`,
    );
  }
  if (
    (trustedKey.notBefore !== undefined && issuedAt.toISOString() < trustedKey.notBefore) ||
    (trustedKey.notAfter !== undefined && expiresAt.toISOString() > trustedKey.notAfter)
  ) {
    throw new CertificationError(
      "CONTROL_ARTIFACT_ATTESTATION_KEY_WINDOW_INVALID",
      `${label} detached producer attestation is outside its enrolled key validity window`,
    );
  }
  const unsigned = { ...document };
  delete unsigned.signature;
  if (!validBase64UrlSignature(document.signature) || !verifySignature(
    null,
    controlArtifactAttestationSigningBytes(unsigned),
    trustedKey.publicKey,
    Buffer.from(document.signature, "base64url"),
  )) {
    throw new CertificationError(
      "CONTROL_ARTIFACT_ATTESTATION_SIGNATURE_INVALID",
      `${label} detached producer attestation failed Ed25519 verification`,
    );
  }
  if (canonicalJson(claims) !== canonicalJson(expectedClaims)) {
    throw new CertificationError(
      "CONTROL_ARTIFACT_ATTESTATION_BINDING_MISMATCH",
      `${label} detached producer attestation is not bound to the exact raw artifact, release, wave, metric, window, value, and state`,
    );
  }
  return {
    attestationId,
    nonce,
    signature: document.signature,
    attestationSha256: artifact.artifact.sha256,
    issuer,
    provider,
    keyId,
    authorityRole,
    publicKeySha256: trustedKey.publicKeySha256,
  };
}

function validateControlArtifactAttestationClaims(value, label) {
  const claims = plainObject(value, `${label} attestation claims`);
  requireExactObjectKeys(claims, [
    "artifactType", "artifactId", "artifactSha256", "relatedArtifactSha256", "releaseId",
    "tenantId", "launchId", "deploymentId", "repositoryCommit", "componentSetSha256",
    "guardrailPolicySha256", "wave", "domain", "signalId", "unit", "windowStart",
    "windowEnd", "eventAt", "threshold", "observedValue", "state",
  ], `${label} attestation claims`);
  if (!Object.prototype.hasOwnProperty.call(CONTROL_ARTIFACT_PROVIDER_PREFIXES, claims.artifactType)) {
    throw new CertificationError("CONTROL_ARTIFACT_ATTESTATION_CLAIMS_INVALID", `${label} attestation artifactType is unsupported`);
  }
  identifier(claims.artifactId, `${label} attestation artifactId`);
  exactSha256(claims.artifactSha256, `${label} attestation artifactSha256`);
  if (claims.relatedArtifactSha256 !== null) exactSha256(claims.relatedArtifactSha256, `${label} attestation relatedArtifactSha256`);
  for (const field of ["releaseId", "tenantId", "launchId", "deploymentId", "wave", "domain", "signalId", "unit", "state"]) {
    identifier(claims[field], `${label} attestation ${field}`);
  }
  exactCommit(claims.repositoryCommit, `${label} attestation repositoryCommit`);
  exactSha256(claims.componentSetSha256, `${label} attestation componentSetSha256`);
  exactSha256(claims.guardrailPolicySha256, `${label} attestation guardrailPolicySha256`);
  const windowStart = canonicalTimestamp(claims.windowStart, `${label} attestation windowStart`);
  const windowEnd = canonicalTimestamp(claims.windowEnd, `${label} attestation windowEnd`);
  const eventAt = canonicalTimestamp(claims.eventAt, `${label} attestation eventAt`);
  if (windowEnd <= windowStart || eventAt < windowStart || eventAt > windowEnd) {
    throw new CertificationError("CONTROL_ARTIFACT_ATTESTATION_TIME_INVALID", `${label} attestation event is outside its closed wave window`);
  }
  for (const [field, allowNull] of [["threshold", false], ["observedValue", claims.artifactType === "monitoring_query"]]) {
    if (allowNull && claims[field] === null) continue;
    if (typeof claims[field] !== "number" || !Number.isFinite(claims[field]) || claims[field] < 0) {
      throw new CertificationError("CONTROL_ARTIFACT_ATTESTATION_CLAIMS_INVALID", `${label} attestation ${field} must be a finite non-negative number`);
    }
  }
  if ((claims.artifactType === "monitoring_query") !== (claims.observedValue === null)) {
    throw new CertificationError("CONTROL_ARTIFACT_ATTESTATION_CLAIMS_INVALID", `${label} attestation observedValue nullability does not match its artifact type`);
  }
  if (
    (["monitoring_query", "pause_command"].includes(claims.artifactType) && claims.relatedArtifactSha256 !== null) ||
    (["monitoring_result", "pause_receipt"].includes(claims.artifactType) && claims.relatedArtifactSha256 === null)
  ) {
    throw new CertificationError("CONTROL_ARTIFACT_ATTESTATION_CLAIMS_INVALID", `${label} attestation related-artifact digest does not match its producer boundary`);
  }
  return { ...claims };
}

function mapReleaseControlValidation(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof B127ReleaseControlError) {
      throw new CertificationError(error.code, error.message, error.status);
    }
    throw error;
  }
}

function validateEvidenceSet(rowsValue, expected) {
  const batchId = expected.batchId ?? "B127";
  const code = (suffix) => `${batchId}_${suffix}`;
  if (!Array.isArray(rowsValue)) {
    throw new CertificationError("EVIDENCE_SOURCE_INVALID", `The ${batchId} source returned an invalid evidence set`);
  }
  if (rowsValue.length < 5) {
    throw blocked(code("EVIDENCE_INCOMPLETE"), `${batchId} requires at least five consumed production evidence envelopes`);
  }
  const rowsById = new Map(rowsValue.map((row) => [row.id, row]));
  if (rowsById.size !== rowsValue.length || rowsById.size !== expected.expectedIds.length) {
    throw blocked(code("EVIDENCE_INCOMPLETE"), `One or more ${batchId} evidence envelopes are missing or duplicated`);
  }
  for (const evidenceId of expected.expectedIds) {
    if (!rowsById.has(evidenceId)) {
      throw blocked(code("EVIDENCE_INCOMPLETE"), `${batchId} evidence ${evidenceId} is not stored`);
    }
  }

  const validated = [];
  const signerIssuers = new Set();
  const signerPublicKeys = new Set();
  for (const evidenceId of [...expected.expectedIds].sort()) {
    const row = rowsById.get(evidenceId);
    if (
      row.tenant_id !== expected.tenantId ||
      row.envelope_version !== "ltm.external-evidence.v1" ||
      row.environment !== "production" ||
      row.algorithm !== "Ed25519" ||
      row.status !== "verified" ||
      row.revoked_at !== null ||
      row.revocation_reason !== null
    ) {
      throw new CertificationError(code("EVIDENCE_STATE_INVALID"), `Evidence ${evidenceId} is not a verified production Ed25519 envelope`);
    }
    if (
      row.scope !== expected.expectedScope ||
      row.provider !== expected.expectedProvider ||
      row.artifact_sha256 !== expected.expectedArtifactSha256
    ) {
      throw new CertificationError(code("EVIDENCE_BINDING_MISMATCH"), `Evidence ${evidenceId} is not bound to this exact ${batchId} production certificate`);
    }
    if (
      row.replay_policy !== "single_use" ||
      row.consumed_at === null ||
      row.consumption_scope !== expected.expectedScope ||
      !SHA256.test(row.consumption_key_hash ?? "")
    ) {
      throw blocked(code("EVIDENCE_NOT_CONSUMED"), `Evidence ${evidenceId} has not been irreversibly consumed by ${batchId}`);
    }
    const issuedAt = canonicalTimestamp(row.issued_at, `${evidenceId}.issuedAt`);
    const expiresAt = canonicalTimestamp(row.expires_at, `${evidenceId}.expiresAt`);
    const verifiedAt = canonicalTimestamp(row.verified_at, `${evidenceId}.verifiedAt`);
    const consumedAt = canonicalTimestamp(row.consumed_at, `${evidenceId}.consumedAt`);
    if (issuedAt.getTime() > expected.now.getTime() + CLOCK_SKEW_MS || verifiedAt.getTime() > expected.now.getTime() + CLOCK_SKEW_MS || consumedAt.getTime() > expected.now.getTime() + CLOCK_SKEW_MS) {
      throw new CertificationError(code("EVIDENCE_FROM_FUTURE"), `Evidence ${evidenceId} contains a future timestamp`);
    }
    if (expected.minimumIssuedAt !== undefined && issuedAt < canonicalTimestamp(expected.minimumIssuedAt, "minimum evidence issuance time")) {
      throw new CertificationError(code("EVIDENCE_PREDATES_MANIFEST"), `Evidence ${evidenceId} predates the artifact it signs`);
    }
    if (verifiedAt < issuedAt || consumedAt < verifiedAt) {
      throw new CertificationError(code("EVIDENCE_TIME_ORDER_INVALID"), `Evidence ${evidenceId} verification or consumption time is inconsistent`);
    }
    if (expected.maximumConsumedAt !== undefined && consumedAt > canonicalTimestamp(expected.maximumConsumedAt, "maximum evidence consumption time")) {
      throw new CertificationError(code("EVIDENCE_AFTER_CERTIFICATE"), `Evidence ${evidenceId} was consumed after the certificate was frozen`);
    }
    if (expected.minimumConsumedAt !== undefined && consumedAt < canonicalTimestamp(expected.minimumConsumedAt, "minimum evidence consumption time")) {
      throw blocked(code("EVIDENCE_CONSUMED_BEFORE_GLOBAL_OBSERVATION"), `Evidence ${evidenceId} was consumed before the global wave observation completed`);
    }
    if (expiresAt.getTime() <= expected.now.getTime() || expiresAt <= issuedAt) {
      throw blocked(code("EVIDENCE_EXPIRED"), `Evidence ${evidenceId} is expired`);
    }
    identifier(row.issuer, `${evidenceId}.issuer`);
    identifier(row.provider, `${evidenceId}.provider`);
    identifier(row.key_id, `${evidenceId}.keyId`);
    identifier(row.nonce, `${evidenceId}.nonce`);
    if (/^(?:test|sandbox)(?:[:._-]|$)/i.test(row.issuer) || /^(?:test|sandbox)(?:[:._-]|$)/i.test(row.provider)) {
      throw new CertificationError("TEST_EVIDENCE_IN_PRODUCTION", `Evidence ${evidenceId} uses a test or sandbox identity`);
    }
    const trustedKey = expected.trustedKeys.find((key) =>
      key.issuer === row.issuer && key.provider === row.provider && key.keyId === row.key_id,
    );
    if (trustedKey === undefined) {
      throw blocked(code("TRUST_KEY_MISSING"), `No trusted production key is configured for evidence ${evidenceId}`);
    }
    if (!trustedKey.allowedEnvironments.includes("production") || !scopeAllowed(trustedKey.allowedScopes, row.scope)) {
      throw new CertificationError(code("TRUST_POLICY_MISMATCH"), `Trusted key policy does not permit evidence ${evidenceId}`);
    }
    if (batchId === "B127") {
      if (!trustedKey.authorityRoles.includes(B127_PRODUCTION_RELEASE_AUTHORITY_ROLE)) {
        throw blocked(
          "B127_RELEASE_AUTHORITY_NOT_TRUSTED",
          `Evidence ${evidenceId} is not signed by an independently enrolled B127 production release authority`,
        );
      }
      if (
        trustedKey.allowedScopes.length !== 1 || trustedKey.allowedScopes[0] !== row.scope ||
        trustedKey.allowedEnvironments.length !== 1 || trustedKey.allowedEnvironments[0] !== "production"
      ) {
        throw new CertificationError(
          "B127_RELEASE_AUTHORITY_POLICY_INVALID",
          `Evidence ${evidenceId} must use an exact B127 scope and a production-only trust policy`,
        );
      }
      if (
        !trustedKey.provider.startsWith("release-control:") ||
        GENERAL_GATEWAY_AUTHORITY_IDENTITY.test(trustedKey.issuer) ||
        GENERAL_GATEWAY_AUTHORITY_IDENTITY.test(trustedKey.provider)
      ) {
        throw new CertificationError(
          "B127_RELEASE_AUTHORITY_IDENTITY_INVALID",
          `Evidence ${evidenceId} cannot use an integration-gateway, direct-evidence, supply-event, or callback signer`,
        );
      }
    }
    if (
      (trustedKey.notBefore !== undefined && row.issued_at < trustedKey.notBefore) ||
      (trustedKey.notAfter !== undefined && (row.issued_at > trustedKey.notAfter || row.expires_at > trustedKey.notAfter))
    ) {
      throw new CertificationError(code("TRUST_KEY_WINDOW_MISMATCH"), `Evidence ${evidenceId} is outside its trusted key validity window`);
    }
    const envelope = {
      version: row.envelope_version,
      evidenceId: row.id,
      tenantId: row.tenant_id,
      issuer: row.issuer,
      provider: row.provider,
      environment: row.environment,
      scope: row.scope,
      artifactSha256: row.artifact_sha256,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      nonce: row.nonce,
      replayPolicy: row.replay_policy,
      algorithm: row.algorithm,
      keyId: row.key_id,
    };
    if (!validBase64UrlSignature(row.signature) || !verifySignature(
      null,
      Buffer.from(canonicalJson(envelope), "utf8"),
      trustedKey.publicKey,
      Buffer.from(row.signature, "base64url"),
    )) {
      throw new CertificationError(code("EVIDENCE_SIGNATURE_INVALID"), `Evidence ${evidenceId} failed Ed25519 signature verification`);
    }
    signerIssuers.add(row.issuer);
    signerPublicKeys.add(sha256Bytes(trustedKey.publicKey.export({ type: "spki", format: "der" })));
    validated.push(row);
  }
  const signerCount = new Set(validated.map((row) => `${row.issuer}\n${row.key_id}`)).size;
  if (signerCount < 5 || signerIssuers.size < 5 || signerPublicKeys.size < 5) {
    throw blocked(code("SIGNER_DIVERSITY_INSUFFICIENT"), `${batchId} requires at least five distinct issuers and Ed25519 public keys`);
  }
  return validated;
}

function validateApprovalEvidence(approvals, evidence, recordApprovalIds, trustedKeys) {
  const manifestApprovalIds = Object.values(approvals).map((approval) => approval.approvalId);
  if (!sameStringSet(recordApprovalIds, manifestApprovalIds) || recordApprovalIds.length !== manifestApprovalIds.length) {
    throw new CertificationError("APPROVAL_RECORD_MISMATCH", "B127 approvalIds must exactly equal the required manifest approval IDs");
  }
  const rowsById = new Map(evidence.map((row) => [row.id, row]));
  const usedEvidence = new Set();
  for (const [name, approval] of Object.entries(approvals)) {
    if (!recordApprovalIds.includes(approval.approvalId)) {
      throw new CertificationError("APPROVAL_RECORD_MISMATCH", `${name} approval ID is not present in the B127 record`);
    }
    const row = rowsById.get(approval.evidenceId);
    if (row === undefined) {
      throw blocked("APPROVAL_EVIDENCE_MISSING", `${name} does not reference a verified B127 evidence envelope`);
    }
    if (row.issuer !== approval.issuer) {
      throw new CertificationError("APPROVAL_ISSUER_MISMATCH", `${name} issuer does not match its signed B127 evidence`);
    }
    const key = trustedKeys.find((candidate) =>
      candidate.issuer === row.issuer && candidate.provider === row.provider && candidate.keyId === row.key_id,
    );
    const requiredRole = APPROVAL_AUTHORITY_ROLES[name];
    if (key === undefined || requiredRole === undefined || !key.authorityRoles.includes(requiredRole)) {
      throw blocked(
        "APPROVAL_AUTHORITY_ROLE_NOT_TRUSTED",
        `${name} signer is not enrolled for the required ${requiredRole ?? "unknown"} authority role`,
      );
    }
    usedEvidence.add(row.id);
  }
  if (usedEvidence.size < 5) {
    throw blocked("APPROVAL_EVIDENCE_DIVERSITY_INSUFFICIENT", "The required approvals must reference at least five distinct evidence envelopes");
  }
  for (const row of evidence) {
    if (!usedEvidence.has(row.id)) {
      throw new CertificationError("UNREFERENCED_B127_EVIDENCE", `Evidence ${row.id} is not referenced by a required release approval`);
    }
  }
}

function validateProductionChangeSignerSeparation(approval, evidence, trustedKeys) {
  const row = evidence.find((entry) => entry.id === approval.evidenceId);
  const primaryKey = row === undefined ? undefined : trustedKeys.find((key) =>
    key.issuer === row.issuer && key.provider === row.provider && key.keyId === row.key_id,
  );
  if (row === undefined || primaryKey === undefined) throw blocked("CHANGE_PRIMARY_SIGNER_MISSING", "Production change primary signer evidence is missing");
  const primaryPublicKeySha256 = primaryKey.publicKeySha256;
  const executor = approval.subject.executor;
  const executorKey = trustedKeys.find((key) =>
    key.issuer === executor.issuer && key.keyId === executor.keyId &&
    key.authorityRoles.includes(PRODUCTION_CHANGE_EXECUTOR_ROLE),
  );
  if (executorKey === undefined) {
    throw blocked("CHANGE_EXECUTOR_TRUST_MISSING", "The production change executor is not enrolled under a trusted executor key");
  }
  if (
    row.issuer === executor.issuer || row.key_id === executor.keyId ||
    primaryPublicKeySha256 === executorKey.publicKeySha256
  ) {
    throw new CertificationError("CHANGE_APPROVER_NOT_INDEPENDENT", "Production change primary signer is not independent from the executor");
  }
  for (const approver of approval.approverSignatures) {
    if (approver.issuer === row.issuer || approver.keyId === row.key_id || approver.publicKeySha256 === primaryPublicKeySha256) {
      throw new CertificationError("CHANGE_APPROVER_NOT_INDEPENDENT", "A production change approver reuses the primary change signer identity or public key");
    }
  }
}

function validateProductionChangeApproverEvidence({
  root,
  artifactPaths,
  trustedKeys,
  tenantId,
  launchId,
  repositoryCommit,
  releaseSubject,
  approval,
  now,
}) {
  const subject = plainObject(approval.subject, "production change approval subject");
  const executorValue = plainObject(subject.executor, "production change executor");
  const executor = {
    actorId: identifier(executorValue.actorId, "production change executor.actorId"),
    issuer: identifier(executorValue.issuer, "production change executor.issuer"),
    keyId: identifier(executorValue.keyId, "production change executor.keyId"),
  };
  const executorKey = trustedKeys.find((key) => key.issuer === executor.issuer && key.keyId === executor.keyId && key.authorityRoles.includes(PRODUCTION_CHANGE_EXECUTOR_ROLE));
  if (executorKey === undefined) {
    throw blocked("CHANGE_EXECUTOR_TRUST_MISSING", "The production change executor is not enrolled under a trusted executor key");
  }
  const expectedClaims = {
    tenantId,
    launchId,
    changeId: subject.changeId,
    deploymentId: releaseSubject.deploymentId,
    repositoryCommit,
    componentSetSha256: releaseSubject.componentSetSha256,
    guardrailPolicySha256: releaseSubject.guardrailPolicySha256,
    waveObservationSetSha256: releaseSubject.waveObservationSetSha256,
    rollbackForwardDrillSha256: releaseSubject.rollbackForwardDrillSha256,
    windowStart: releaseSubject.goLive.windowStart,
    windowEnd: releaseSubject.goLive.windowEnd,
    executor,
    decision: "approved",
  };
  const references = Array.isArray(subject.approverEvidence) ? subject.approverEvidence : [];
  const signatures = references.map((reference, index) => {
    const artifact = validateManifestArtifact(
      root,
      reference,
      `production change approver evidence ${index + 1}`,
      MAX_APPROVAL_ARTIFACT_BYTES,
      artifactPaths,
      "CHANGE_APPROVER_ARTIFACT_DIGEST_MISMATCH",
    );
    const document = parseJsonObject(artifact.file.bytes.toString("utf8"), `production change approver evidence ${index + 1}`);
    requireExactObjectKeys(document, [
      "schemaVersion", "evidenceId", "approverId", "issuer", "keyId", "authorityRole",
      "algorithm", "approvedAt", "claims", "signature",
    ], `production change approver evidence ${index + 1}`);
    if (document.schemaVersion !== "ltm.production-change-approver-evidence.v1" || document.algorithm !== "Ed25519") {
      throw new CertificationError("CHANGE_APPROVER_CONTRACT_INVALID", "Production change approver evidence uses an unsupported schema or signature algorithm");
    }
    const evidenceId = identifier(document.evidenceId, `change approver ${index + 1}.evidenceId`);
    const approverId = identifier(document.approverId, `change approver ${index + 1}.approverId`);
    const issuer = identifier(document.issuer, `change approver ${index + 1}.issuer`);
    const keyId = identifier(document.keyId, `change approver ${index + 1}.keyId`);
    const authorityRole = nonEmptyText(document.authorityRole, `change approver ${index + 1}.authorityRole`, 128);
    if (!CHANGE_APPROVER_AUTHORITY_ROLES.includes(authorityRole)) {
      throw new CertificationError("CHANGE_APPROVER_ROLE_INVALID", "Production change approver evidence has an unsupported authority role");
    }
    const approvedAt = canonicalTimestamp(document.approvedAt, `change approver ${index + 1}.approvedAt`);
    if (approvedAt.toISOString() !== approval.approvedAt || approvedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      throw new CertificationError("CHANGE_APPROVER_TIME_INVALID", "Production change approver evidence is not bound to the approval time");
    }
    const claims = plainObject(document.claims, `change approver ${index + 1}.claims`);
    if (canonicalJson(claims) !== canonicalJson(expectedClaims)) {
      throw new CertificationError("CHANGE_APPROVER_BINDING_MISMATCH", "Production change approver evidence is not bound to this release, deployment, controls, executor, and window");
    }
    const trustedKey = trustedKeys.find((key) => key.issuer === issuer && key.keyId === keyId && key.provider === `change-approval:${subject.changeId}`);
    const scope = `${CHANGE_APPROVER_SCOPE_PREFIX}${sha256Bytes(Buffer.from(canonicalJson(claims), "utf8"))}`;
    if (trustedKey === undefined || !trustedKey.authorityRoles.includes(authorityRole) || !trustedKey.allowedEnvironments.includes("production") || !scopeAllowed(trustedKey.allowedScopes, scope)) {
      throw blocked("CHANGE_APPROVER_TRUST_MISSING", "A production change approver key is not independently enrolled for its exact authority role and release scope");
    }
    if (
      approverId === executor.actorId || issuer === executor.issuer || keyId === executor.keyId ||
      issuer === approval.issuer || trustedKey.publicKeySha256 === executorKey.publicKeySha256
    ) {
      throw new CertificationError("CHANGE_APPROVER_NOT_INDEPENDENT", "A production change approver is not independent from the executor or primary change authority");
    }
    if (
      (trustedKey.notBefore !== undefined && approvedAt.toISOString() < trustedKey.notBefore) ||
      (trustedKey.notAfter !== undefined && approvedAt.toISOString() > trustedKey.notAfter)
    ) {
      throw new CertificationError("CHANGE_APPROVER_KEY_WINDOW_INVALID", "A production change approval was signed outside its trusted key validity window");
    }
    const unsigned = { ...document };
    delete unsigned.signature;
    if (!validBase64UrlSignature(document.signature) || !verifySignature(
      null,
      Buffer.from(canonicalJson(unsigned), "utf8"),
      trustedKey.publicKey,
      Buffer.from(document.signature, "base64url"),
    )) {
      throw new CertificationError("CHANGE_APPROVER_SIGNATURE_INVALID", "Production change approver evidence failed Ed25519 verification");
    }
    return {
      evidenceId,
      approverId,
      issuer,
      keyId,
      authorityRole,
      publicKeySha256: trustedKey.publicKeySha256,
      artifact: artifact.artifact,
    };
  });
  for (const field of ["evidenceId", "approverId", "issuer", "keyId", "publicKeySha256", "authorityRole"]) {
    if (new Set(signatures.map((entry) => entry[field])).size !== signatures.length) {
      throw new CertificationError("CHANGE_APPROVER_DIVERSITY_INSUFFICIENT", `Production change approvers must use distinct ${field} values`);
    }
  }
  if (signatures.length < 2 || !CHANGE_APPROVER_AUTHORITY_ROLES.every((role) => signatures.some((entry) => entry.authorityRole === role))) {
    throw blocked("CHANGE_APPROVER_DIVERSITY_INSUFFICIENT", "Production change approval requires distinct risk and operations approver signatures");
  }
  return signatures;
}

export function loadTrustedKeys(pathValue, now) {
  const path = requiredPath(pathValue, "trusted evidence keys path", "TRUSTED_EVIDENCE_KEYS_REQUIRED");
  if (!existsSync(path)) throw blocked("TRUSTED_EVIDENCE_KEYS_NOT_FOUND", "The trusted evidence keys file does not exist");
  const file = readStableFile(path, "trusted evidence keys", MAX_TRUST_FILE_BYTES);
  const document = parseJsonObject(file.bytes.toString("utf8"), "trusted evidence keys");
  if (document.schemaVersion !== "ltm.trusted-evidence-keys.v1" || !Array.isArray(document.keys) || document.keys.length < 5) {
    throw blocked("TRUSTED_EVIDENCE_KEYS_INCOMPLETE", "At least five trusted keys are required in ltm.trusted-evidence-keys.v1 format");
  }
  const identities = new Set();
  const publicKeyIdentities = new Map();
  const identityPublicKeys = new Map();
  return document.keys.map((value, index) => {
    const key = plainObject(value, `trusted key ${index}`);
    const issuer = identifier(key.issuer, `trusted key ${index} issuer`);
    const provider = identifier(key.provider, `trusted key ${index} provider`);
    const keyId = identifier(key.keyId, `trusted key ${index} keyId`);
    if (/^(?:test|sandbox)(?:[:._-]|$)/i.test(issuer) || /^(?:test|sandbox)(?:[:._-]|$)/i.test(provider)) {
      throw new CertificationError("PRODUCTION_TRUST_IDENTITY_INVALID", "Production trusted keys cannot use test or sandbox identities");
    }
    if (key.algorithm !== "Ed25519") {
      throw new CertificationError("TRUST_KEY_ALGORITHM_INVALID", `Trusted key ${keyId} must use Ed25519`);
    }
    const allowedScopes = stringArray(key.allowedScopes, `trusted key ${keyId} allowedScopes`, 1, 100);
    for (const scope of allowedScopes) {
      if (scope.trim() === "" || scope.length > 512 || (scope.includes("*") && !scope.endsWith("*"))) {
        throw new CertificationError("TRUST_KEY_SCOPE_INVALID", `Trusted key ${keyId} has an invalid allowed scope`);
      }
    }
    const allowedEnvironments = stringArray(key.allowedEnvironments, `trusted key ${keyId} allowedEnvironments`, 1, 4);
    if (!allowedEnvironments.includes("production") || allowedEnvironments.some((environment) => !["test", "sandbox", "staging", "production"].includes(environment))) {
      throw new CertificationError("TRUST_KEY_ENVIRONMENT_INVALID", `Trusted key ${keyId} is not authorized for production`);
    }
    const authorityRoles = key.authorityRoles === undefined
      ? []
      : stringArray(key.authorityRoles, `trusted key ${keyId} authorityRoles`, 1, Object.keys(APPROVAL_AUTHORITY_ROLES).length + CHANGE_APPROVER_AUTHORITY_ROLES.length + Object.keys(CONTROL_ARTIFACT_AUTHORITY_ROLES).length + 3);
    const knownAuthorityRoles = new Set([
      ...Object.values(APPROVAL_AUTHORITY_ROLES),
      ...CHANGE_APPROVER_AUTHORITY_ROLES,
      ...Object.values(CONTROL_ARTIFACT_AUTHORITY_ROLES),
      B127_PRODUCTION_RELEASE_AUTHORITY_ROLE,
      PRODUCTION_CHANGE_EXECUTOR_ROLE,
      SUPPLY_CHAIN_AUTHORITY_ROLE,
    ]);
    if (authorityRoles.some((role) => !knownAuthorityRoles.has(role))) {
      throw new CertificationError("TRUST_KEY_AUTHORITY_ROLE_INVALID", `Trusted key ${keyId} declares an unknown authority role`);
    }
    const approvalRoles = new Set(Object.values(APPROVAL_AUTHORITY_ROLES));
    const declaresApprovalRole = authorityRoles.some((role) => approvalRoles.has(role));
    const isB127ReleaseAuthority = authorityRoles.includes(B127_PRODUCTION_RELEASE_AUTHORITY_ROLE);
    if (declaresApprovalRole && !isB127ReleaseAuthority) {
      throw new CertificationError(
        "B127_RELEASE_AUTHORITY_ROLE_REQUIRED",
        `Trusted key ${keyId} cannot declare a B127 approval role without ${B127_PRODUCTION_RELEASE_AUTHORITY_ROLE}`,
      );
    }
    if (isB127ReleaseAuthority) {
      if (
        provider.startsWith("release-control:") === false ||
        GENERAL_GATEWAY_AUTHORITY_IDENTITY.test(issuer) ||
        GENERAL_GATEWAY_AUTHORITY_IDENTITY.test(provider)
      ) {
        throw new CertificationError(
          "B127_RELEASE_AUTHORITY_IDENTITY_INVALID",
          `Trusted key ${keyId} cannot enroll a general integration-gateway or provider callback identity as a B127 release authority`,
        );
      }
      if (
        allowedScopes.length !== 1 || !/^ltm-evidence:v1:[a-f0-9]{64}$/.test(allowedScopes[0]) ||
        allowedEnvironments.length !== 1 || allowedEnvironments[0] !== "production"
      ) {
        throw new CertificationError(
          "B127_RELEASE_AUTHORITY_POLICY_INVALID",
          `Trusted key ${keyId} must be bound to one exact B127 evidence scope and production only`,
        );
      }
      if (authorityRoles.some((role) => role !== B127_PRODUCTION_RELEASE_AUTHORITY_ROLE && !approvalRoles.has(role))) {
        throw new CertificationError(
          "B127_RELEASE_AUTHORITY_ROLE_CONFLICT",
          `Trusted key ${keyId} cannot combine the B127 release role with gateway, supply-chain, rollout-control, or change-executor roles`,
        );
      }
    }
    let publicKey;
    try {
      if (typeof key.publicKeyPem !== "string" || key.publicKeyPem.length === 0 || key.publicKeyPem.length > 16_384 || key.publicKeyPem.includes("\0")) {
        throw new Error("invalid PEM text");
      }
      publicKey = createPublicKey(key.publicKeyPem);
    } catch {
      throw new CertificationError("TRUST_KEY_INVALID", `Trusted key ${keyId} is not a valid public key`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new CertificationError("TRUST_KEY_TYPE_INVALID", `Trusted key ${keyId} is not Ed25519`);
    }
    const publicKeySha256 = sha256Bytes(publicKey.export({ type: "spki", format: "der" }));
    const signerIdentity = `${issuer}\n${provider}\n${keyId}`;
    const priorIdentity = publicKeyIdentities.get(publicKeySha256);
    if (priorIdentity !== undefined && priorIdentity !== signerIdentity) {
      throw new CertificationError(
        "TRUST_KEY_PUBLIC_KEY_REUSED",
        `Trusted key ${keyId} reuses Ed25519 public key material enrolled under a different signer identity`,
      );
    }
    const priorPublicKey = identityPublicKeys.get(signerIdentity);
    if (priorPublicKey !== undefined && priorPublicKey !== publicKeySha256) {
      throw new CertificationError(
        "TRUST_KEY_IDENTITY_KEY_MISMATCH",
        `Trusted signer identity ${keyId} maps to inconsistent Ed25519 public keys`,
      );
    }
    publicKeyIdentities.set(publicKeySha256, signerIdentity);
    identityPublicKeys.set(signerIdentity, publicKeySha256);
    const notBefore = key.notBefore === undefined ? undefined : canonicalTimestamp(key.notBefore, `trusted key ${keyId} notBefore`).toISOString();
    const notAfter = key.notAfter === undefined ? undefined : canonicalTimestamp(key.notAfter, `trusted key ${keyId} notAfter`).toISOString();
    if (notBefore !== undefined && notAfter !== undefined && notAfter <= notBefore) {
      throw new CertificationError("TRUST_KEY_WINDOW_INVALID", `Trusted key ${keyId} has an invalid validity window`);
    }
    if (notAfter !== undefined && notAfter <= now.toISOString()) {
      throw blocked("TRUST_KEY_EXPIRED", `Trusted key ${keyId} has expired`);
    }
    const identity = `${issuer}\n${provider}\n${keyId}`;
    if (identities.has(identity)) {
      throw new CertificationError("TRUST_KEY_DUPLICATE", `Trusted key identity ${keyId} is duplicated`);
    }
    identities.add(identity);
    return { issuer, provider, keyId, allowedScopes, allowedEnvironments, authorityRoles, publicKey, publicKeySha256, notBefore, notAfter };
  });
}

function validateSbom(bytes, format) {
  try {
    return validateReleaseSbom(bytes, format);
  } catch (error) {
    if (error instanceof EvidenceContractError) {
      throw new CertificationError(error.code, error.message);
    }
    throw error;
  }
}

function assertRequiredTables(database) {
  const schema = database.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get();
  if (schema?.value !== "5") {
    throw new CertificationError("DATABASE_SCHEMA_UNSUPPORTED", "The B127 verifier requires runtime database schema version 5 for SQLite evidence");
  }
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('records', 'external_evidence', 'evidence_consumptions')",
  ).all();
  if (new Set(tables.map((row) => row.name)).size !== 3) {
    throw new CertificationError("DATABASE_SCHEMA_INCOMPLETE", "The B127 database is missing release evidence tables");
  }
}

function b127EvidenceScope({ tenantId, provider, artifactSha256, launchId }) {
  const fields = [
    "ltm-capability-evidence-v1",
    tenantId,
    "B127",
    "approveStagedProductionLaunch",
    "release-control-plane",
    provider,
    artifactSha256,
    "production",
    launchId,
  ];
  const canonical = fields.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `ltm-evidence:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

function b126EvidenceScope({ tenantId, provider, artifactSha256, certificationId }) {
  const fields = [
    "ltm-capability-evidence-v1",
    tenantId,
    "B126",
    "certifyCommercialE2e",
    "commercial-e2e",
    provider,
    artifactSha256,
    "production",
    certificationId,
  ];
  const canonical = fields.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `ltm-evidence:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function readRootRelativeFile(root, relativePath, label, maximumBytes) {
  const rootPath = realpathSync(root);
  const file = readStableFile(resolveInsideRoot(rootPath, relativePath, label), label, maximumBytes);
  const relation = relative(rootPath, file.path);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new CertificationError("ARTIFACT_PATH_OUTSIDE_ROOT", `${label} resolves outside the product root`);
  }
  return file;
}

function resolveInsideRoot(root, relativePath, label) {
  const resolved = resolve(root, safeRelativePath(relativePath, label));
  const relation = relative(root, resolved);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new CertificationError("ARTIFACT_PATH_OUTSIDE_ROOT", `${label} must resolve to a file below the product root`);
  }
  return resolved;
}

export function readStableFile(pathValue, label, maximumBytes) {
  const path = resolve(pathValue);
  if (!existsSync(path)) throw blocked("RELEASE_ARTIFACT_NOT_FOUND", `${label} was not found`);
  const pathStat = lstatSync(path);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new CertificationError("RELEASE_ARTIFACT_TYPE_INVALID", `${label} must be a regular non-symlink file`);
  }
  if ((pathStat.mode & 0o022) !== 0) {
    throw new CertificationError("RELEASE_ARTIFACT_PERMISSIONS_INVALID", `${label} must not be group- or world-writable`);
  }
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (before.size <= 0 || before.size > maximumBytes) {
      throw new CertificationError("RELEASE_ARTIFACT_SIZE_INVALID", `${label} has an invalid size`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
      throw new CertificationError("RELEASE_ARTIFACT_CHANGED", `${label} changed while it was being verified`);
    }
    return { path: realpathSync(path), bytes };
  } finally {
    closeSync(descriptor);
  }
}

function assertRegularStablePath(pathValue, label) {
  const stat = lstatSync(pathValue);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CertificationError("DATABASE_PATH_INVALID", `${label} must be a regular non-symlink file`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new CertificationError("DATABASE_PERMISSIONS_INVALID", `${label} must not be group- or world-writable`);
  }
}

function parseJsonObject(serialized, label) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CertificationError("JSON_INVALID", `${label} is not valid JSON`);
  }
  return plainObject(parsed, label);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CertificationError("OBJECT_INVALID", `${label} must be a JSON object`);
  }
  return value;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CertificationError("CANONICAL_JSON_INVALID", "Evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new CertificationError("CANONICAL_JSON_INVALID", "Evidence contains a non-JSON value");
}

function validBase64UrlSignature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

export function scopeAllowed(allowedScopes, scope) {
  return allowedScopes.some((allowed) =>
    allowed === "*" || allowed === scope || (allowed.endsWith("*") && scope.startsWith(allowed.slice(0, -1))),
  );
}

function requireMembers(actual, required, label) {
  for (const item of required) {
    if (!actual.includes(item)) throw new CertificationError("REQUIRED_ITEM_MISSING", `${label} must include ${item}`);
  }
}

function requireExactObjectKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new CertificationError("OBJECT_KEYS_INVALID", `${label} must contain exactly ${expected.join(", ")}`);
  }
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function stringArray(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((item) => typeof item !== "string" || item.trim() !== item || item.length === 0 || item.length > 512)) {
    throw new CertificationError("STRING_ARRAY_INVALID", `${label} must contain between ${minimum} and ${maximum} unique strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new CertificationError("STRING_ARRAY_DUPLICATE", `${label} must contain unique strings`);
  }
  return [...value];
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new CertificationError("IDENTIFIER_INVALID", `${label} has an invalid format`);
  }
  return value;
}

function requiredIdentifier(value, label, code) {
  if (typeof value !== "string" || value.trim().length === 0) throw blocked(code, `${label} is required`);
  return identifier(value, label);
}

function nonEmptyText(value, label, maximum) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CertificationError("TEXT_INVALID", `${label} must contain valid visible text`);
  }
  return value;
}

function releaseVersion(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(value) ||
    /^(?:pending|unknown|latest|none|not[-_.]?configured|n[._-]?a)$/i.test(value)
  ) {
    throw new CertificationError("RELEASE_VERSION_INVALID", `${label} must be a concrete immutable release version`);
  }
  return value;
}

function integerInRange(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CertificationError("INTEGER_RANGE_INVALID", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CertificationError("SHA256_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactCommit(value, label) {
  if (typeof value !== "string" || !GIT_COMMIT.test(value)) {
    throw new CertificationError("COMMIT_INVALID", `${label} must be a full lowercase Git object ID`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new CertificationError("TIMESTAMP_INVALID", `${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CertificationError("TIMESTAMP_INVALID", `${label} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function validDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CertificationError("CLOCK_INVALID", `${label} is invalid`);
  }
  return value;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.includes("\0") || isAbsolute(value)) {
    throw new CertificationError("ARTIFACT_PATH_INVALID", `${label} must be a non-empty relative path`);
  }
  return value;
}

function requiredPath(value, label, code) {
  if (typeof value !== "string" || value.trim().length === 0) throw blocked(code, `${label} is required`);
  return resolve(value);
}

function blocked(code, message, details = undefined) {
  return new CertificationError(code, message, "BLOCKED_EXTERNAL", details);
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  return new Map(argv.map((argument) => {
    const [name, ...rest] = argument.replace(/^--/, "").split("=");
    return [name, rest.length === 0 ? "true" : rest.join("=")];
  }));
}

function checkedOutCommit(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw blocked("GIT_COMMIT_UNAVAILABLE", "The checked-out Git commit could not be resolved");
  return result.stdout.trim();
}

async function runCli() {
  const args = parseArguments(process.argv.slice(2));
  const root = resolve(args.get("root") ?? process.cwd());
  let result;
  try {
    const expectedCommit = args.get("expected-commit") ?? checkedOutCommit(root);
    const certificationProfile = args.get("profile") ?? "production";
    const configuredSource = args.get("source") ?? process.env.LTM_B127_SOURCE ??
      (certificationProfile === "production" ? "postgresql" : "sqlite");
    if (configuredSource !== "postgresql" && configuredSource !== "sqlite") {
      throw new CertificationError("B127_SOURCE_INVALID", "B127 source must be postgresql or sqlite");
    }
    result = await certifyB127({
      root,
      certificationProfile,
      allowInsecureTestConnection: certificationProfile === "test" &&
        (args.get("allow-insecure-test-postgres") === "true" || process.env.LTM_B127_ALLOW_INSECURE_TEST_POSTGRES === "true"),
      ...(configuredSource === "sqlite"
        ? { databasePath: args.get("database") ?? process.env.LTM_B127_DATABASE_PATH ?? process.env.LTM_DATABASE_PATH }
        : { postgresUrl: args.get("postgres-url") ?? process.env.LTM_B127_POSTGRES_URL ?? process.env.DATABASE_URL }),
      manifestPath: args.get("manifest") ?? process.env.LTM_RELEASE_MANIFEST_PATH,
      trustedKeysPath: args.get("trusted-keys") ?? process.env.LTM_TRUSTED_EVIDENCE_KEYS_FILE,
      tenantId: args.get("tenant") ?? process.env.LTM_RELEASE_TENANT_ID,
      launchId: args.get("launch-id") ?? process.env.LTM_RELEASE_LAUNCH_ID,
      expectedCommit,
    });
  } catch (error) {
    result = error instanceof CertificationError
      ? {
          schemaVersion: "ltm.b127-certification-result.v1",
          status: error.status,
          verifiedAt: new Date().toISOString(),
          code: error.code,
          evidence: error.message,
        }
      : {
          schemaVersion: "ltm.b127-certification-result.v1",
          status: "FAIL",
          verifiedAt: new Date().toISOString(),
          code: "UNEXPECTED_CERTIFIER_ERROR",
          evidence: "The B127 verifier failed unexpectedly",
        };
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = args.get("output");
  if (output !== undefined && output !== "true") {
    const outputPath = resolve(root, output);
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(outputPath, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (result.status === "FAIL") process.exitCode = 1;
  else if (result.status === "BLOCKED_EXTERNAL") process.exitCode = 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
