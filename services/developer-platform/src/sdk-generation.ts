import { verify } from "node:crypto";
import { DeveloperPlatformError, digest, required, unique } from "./common.js";

export type SdkLanguage = "typescript" | "python" | "java";
export interface SdkModelField { readonly name: string; readonly type: "string" | "integer" | "number" | "boolean"; readonly required: boolean; }
export interface SdkContract {
  readonly sourceVersion: string;
  readonly openApiSha256: string;
  readonly eventSchemaSha256: string;
  readonly errors: readonly string[];
  readonly models: Readonly<Record<string, readonly SdkModelField[]>>;
  readonly operations: readonly { readonly id: string; readonly method: "GET" | "POST" | "PUT" | "DELETE"; readonly path: string; readonly idempotent: boolean; readonly paginated: boolean }[];
}

export interface GeneratedSdkBundle {
  readonly sourceVersion: string;
  readonly sourceSha256: string;
  readonly files: Readonly<Record<SdkLanguage, Readonly<Record<string, string>>>>;
  readonly fileSha256: Readonly<Record<string, string>>;
  readonly generatedSha256: string;
}

export interface SdkReleaseManifest {
  readonly version: string;
  readonly sourceVersion: string;
  readonly generatedSha256: string;
  readonly compatibleApiMajors: readonly number[];
  readonly deprecatedAfter?: string;
  readonly migrationGuideSha256?: string;
  readonly signature: string;
}

export const INTEGRATION_EXAMPLES = Object.freeze([
  { id: "resumable-upload", operation: "media.upload", requires: ["authentication", "timeout", "cancellation", "idempotency"] },
  { id: "generate", operation: "generation.create", requires: ["consent", "AI label", "idempotency"] },
  { id: "query", operation: "generation.get", requires: ["request ID", "pagination"] },
  { id: "share", operation: "share.create", requires: ["revocation", "expiry", "idempotency"] },
  { id: "order", operation: "order.create", requires: ["quote", "payment truth", "idempotency"] },
  { id: "webhook-verification", operation: "webhook.verify", requires: ["raw bytes", "timestamp", "nonce", "signature"] },
  { id: "partner-session", operation: "partner.session", requires: ["OAuth", "exact scopes", "tenant isolation"] },
] as const);

export class SdkContractCompiler {
  generate(contract: SdkContract): GeneratedSdkBundle {
    validateContract(contract);
    const files = {
      typescript: Object.freeze({ "models.ts": typescriptModels(contract), "client.ts": typescriptClient(contract), "errors.ts": typescriptErrors(contract) }),
      python: Object.freeze({ "models.py": pythonModels(contract), "client.py": pythonClient(contract), "errors.py": pythonErrors(contract) }),
      java: Object.freeze({ "Models.java": javaModels(contract), "Client.java": javaClient(contract), "ApiErrors.java": javaErrors(contract) }),
    } as const;
    const fileSha256 = Object.fromEntries(Object.entries(files).flatMap(([language, languageFiles]) => Object.entries(languageFiles).map(([name, source]) => [`${language}/${name}`, digest(source)])));
    const base = { sourceVersion: contract.sourceVersion, sourceSha256: digest(contract), files, fileSha256: Object.freeze(fileSha256) };
    return Object.freeze({ ...base, generatedSha256: digest(base) });
  }

  verifyReproducible(contract: SdkContract, expected: GeneratedSdkBundle): void {
    const generated = this.generate(contract);
    if (generated.generatedSha256 !== expected.generatedSha256 || digest(generated.files) !== digest(expected.files)) throw new DeveloperPlatformError("CONFLICT", "generated SDK output drifted from its frozen contract");
  }

  assertCompatible(previous: SdkContract, next: SdkContract): void {
    const removedOperations = previous.operations.filter((operation) => !next.operations.some((candidate) => candidate.id === operation.id && candidate.method === operation.method && candidate.path === operation.path));
    const removedModels = Object.entries(previous.models).flatMap(([model, fields]) => fields.filter((field) => !next.models[model]?.some((candidate) => candidate.name === field.name && candidate.type === field.type)).map((field) => `${model}.${field.name}`));
    if ((removedOperations.length > 0 || removedModels.length > 0) && major(next.sourceVersion) <= major(previous.sourceVersion)) throw new DeveloperPlatformError("CONFLICT", "breaking SDK source contract requires a new major version and migration guide");
  }

  verifyRelease(manifest: SdkReleaseManifest, publicKeyPem: string): void {
    if (!/^\d+\.\d+\.\d+$/u.test(manifest.version) || !/^[a-f0-9]{64}$/u.test(manifest.generatedSha256) || manifest.compatibleApiMajors.length === 0) throw new DeveloperPlatformError("VALIDATION_FAILED", "SDK release manifest is invalid");
    if (major(manifest.version) !== major(manifest.sourceVersion) || !manifest.compatibleApiMajors.includes(major(manifest.sourceVersion))) throw new DeveloperPlatformError("CONFLICT", "SDK semantic version and compatibility matrix do not cover the source contract");
    const unsigned = { version: manifest.version, sourceVersion: manifest.sourceVersion, generatedSha256: manifest.generatedSha256, compatibleApiMajors: manifest.compatibleApiMajors, ...(manifest.deprecatedAfter === undefined ? {} : { deprecatedAfter: manifest.deprecatedAfter }), ...(manifest.migrationGuideSha256 === undefined ? {} : { migrationGuideSha256: manifest.migrationGuideSha256 }) };
    if (!verify(null, Buffer.from(JSON.stringify(unsigned), "utf8"), publicKeyPem, Buffer.from(manifest.signature, "base64"))) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "SDK release signature is invalid");
  }
}

function validateContract(contract: SdkContract): void {
  if (!/^\d+\.\d+\.\d+$/u.test(contract.sourceVersion) || !/^[a-f0-9]{64}$/u.test(contract.openApiSha256) || !/^[a-f0-9]{64}$/u.test(contract.eventSchemaSha256)) throw new DeveloperPlatformError("VALIDATION_FAILED", "SDK source contract version or digest is invalid");
  unique(contract.errors, "SDK errors"); unique(contract.operations.map((operation) => operation.id), "SDK operations");
  if (Object.keys(contract.models).length === 0 || contract.operations.length === 0) throw new DeveloperPlatformError("VALIDATION_FAILED", "SDK contract has no models or operations");
  for (const [name, fields] of Object.entries(contract.models)) { required(name, "SDK model name"); unique(fields.map((field) => field.name), `SDK ${name} fields`); }
  for (const operation of contract.operations) { required(operation.id, "operation id"); if (!operation.path.startsWith("/v1/")) throw new DeveloperPlatformError("VALIDATION_FAILED", "SDK operations must use a versioned API path"); if (operation.method !== "GET" && !operation.idempotent) throw new DeveloperPlatformError("POLICY_BLOCKED", "every SDK write must require idempotency"); }
}

function header(contract: SdkContract, comment: string): string { return `${comment} Generated from LTM API ${contract.sourceVersion}; OpenAPI ${contract.openApiSha256}; event contract ${contract.eventSchemaSha256}.\n`; }
function typescriptModels(contract: SdkContract): string { return header(contract, "//") + Object.entries(contract.models).map(([name, fields]) => `export interface ${name} { ${fields.map((field) => `readonly ${field.name}${field.required ? "" : "?"}: ${tsType(field.type)};`).join(" ")} }`).join("\n"); }
function typescriptClient(contract: SdkContract): string { return header(contract, "//") + `export const operations = ${JSON.stringify(contract.operations)} as const;\nexport const transportDefaults = Object.freeze({ timeoutMs: 10000, maxRetries: 2, userAgent: "ltm-sdk-typescript/${contract.sourceVersion}", redactHeaders: ["authorization", "cookie"], requireRequestId: true, requireIdempotencyForWrites: true, cancellation: "AbortSignal" });\n`; }
function typescriptErrors(contract: SdkContract): string { return header(contract, "//") + `export type ApiErrorCode = ${contract.errors.map((error) => JSON.stringify(error)).join(" | ")};\nexport interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string; }\n`; }
function pythonModels(contract: SdkContract): string { return header(contract, "#") + "from dataclasses import dataclass\n" + Object.entries(contract.models).map(([name, fields]) => `@dataclass(frozen=True)\nclass ${name}:\n${fields.map((field) => `    ${field.name}: ${pyType(field.type)}${field.required ? "" : " | None = None"}`).join("\n")}`).join("\n\n"); }
function pythonClient(contract: SdkContract): string { return header(contract, "#") + `OPERATIONS = ${JSON.stringify(contract.operations)}\nTRANSPORT_DEFAULTS = {"timeout_seconds": 10, "max_retries": 2, "user_agent": "ltm-sdk-python/${contract.sourceVersion}", "redact_headers": ("authorization", "cookie"), "require_request_id": True, "require_idempotency_for_writes": True, "cancellation": "caller_deadline"}\n`; }
function pythonErrors(contract: SdkContract): string { return header(contract, "#") + `API_ERROR_CODES = frozenset(${JSON.stringify(contract.errors)})\n# Pages use immutable item tuples and an optional opaque next_cursor.\n`; }
function javaModels(contract: SdkContract): string { return header(contract, "//") + "package com.ailifetime.generated;\npublic final class Models {\n" + Object.entries(contract.models).map(([name, fields]) => `  public record ${name}(${fields.map((field) => `${javaType(field.type)} ${field.name}`).join(", ")}) {}`).join("\n") + "\n}\n"; }
function javaClient(contract: SdkContract): string { return header(contract, "//") + `package com.ailifetime.generated;\npublic final class Client { public static final int TIMEOUT_SECONDS=10; public static final int MAX_RETRIES=2; public static final String USER_AGENT="ltm-sdk-java/${contract.sourceVersion}"; public static final boolean REQUIRE_REQUEST_ID=true; public static final boolean REQUIRE_IDEMPOTENCY_FOR_WRITES=true; private Client(){} }\n`; }
function javaErrors(contract: SdkContract): string { return header(contract, "//") + `package com.ailifetime.generated;\npublic enum ApiErrors { ${contract.errors.join(", ")} }\n`;
}
function tsType(type: SdkModelField["type"]): string { return type === "string" ? "string" : type === "boolean" ? "boolean" : "number"; }
function pyType(type: SdkModelField["type"]): string { return type === "string" ? "str" : type === "boolean" ? "bool" : type === "integer" ? "int" : "float"; }
function javaType(type: SdkModelField["type"]): string { return type === "string" ? "String" : type === "boolean" ? "boolean" : type === "integer" ? "long" : "double"; }
function major(version: string): number { return Number.parseInt(version.split(".")[0] as string, 10); }
