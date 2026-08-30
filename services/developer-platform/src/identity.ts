import { createPublicKey, randomBytes, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { clone, DeveloperPlatformError, digest, required, utc, unique } from "./common.js";

export type CredentialEnvironment = "sandbox" | "staging" | "production";
export type CredentialKind = "api_key" | "oauth_client" | "service_account";

export interface FineGrainedScope {
  readonly resource: string;
  readonly action: "read" | "write" | "delete" | "admin";
  readonly tenantId: string;
  readonly storeIds: readonly string[];
  readonly purpose: string;
  readonly dataCategories: readonly string[];
}

export interface CredentialConstraints {
  readonly ipCidrs: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly mtlsCertificateSha256?: string;
  readonly signingPublicKeyPem?: string;
  readonly ratePerMinute: number;
  readonly budgetMinorPerDay: number;
}

export interface ProductionIssuanceGate {
  readonly contractActive: boolean;
  readonly applicationApproved: boolean;
  readonly securityConfigurationApproved: boolean;
  readonly approverIds: readonly string[];
}

export interface CredentialSecret {
  readonly credentialId: string;
  readonly secret: string;
  readonly shownOnce: true;
}

export interface CredentialSummary {
  readonly id: string;
  readonly partnerId: string;
  readonly applicationId: string;
  readonly environment: CredentialEnvironment;
  readonly kind: CredentialKind;
  readonly scopes: readonly FineGrainedScope[];
  readonly constraints: CredentialConstraints;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  readonly rotationOf?: string;
}

interface StoredCredential extends Omit<CredentialSummary, "revokedAt" | "lastUsedAt"> {
  revokedAt?: string;
  lastUsedAt?: string;
  readonly salt: Buffer;
  readonly secretHash: Buffer;
}

interface StoredToken {
  readonly tokenId: string;
  readonly credentialId: string;
  readonly tokenHash: Buffer;
  readonly salt: Buffer;
  readonly scopes: readonly FineGrainedScope[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface CredentialUse {
  readonly environment: CredentialEnvironment;
  readonly resource: string;
  readonly action: FineGrainedScope["action"];
  readonly tenantId: string;
  readonly storeId?: string;
  readonly purpose: string;
  readonly dataCategory: string;
  readonly sourceIp: string;
  readonly originDomain?: string;
  readonly mtlsCertificateSha256?: string;
  readonly requestBody: Uint8Array;
  readonly requestSignature?: Uint8Array;
  readonly nonce: string;
  readonly costMinor: number;
}

export interface AuthenticatedCredential {
  readonly credentialId: string;
  readonly partnerId: string;
  readonly applicationId: string;
  readonly scopes: readonly FineGrainedScope[];
}

export class DeveloperIdentityService {
  readonly #credentials = new Map<string, StoredCredential>();
  readonly #tokens = new Map<string, StoredToken>();
  readonly #nonces = new Map<string, number>();
  readonly #usage = new Map<string, number[]>();
  readonly #dailySpend = new Map<string, { day: string; amountMinor: number }>();
  readonly #audit: Array<Readonly<Record<string, string | number>>> = [];

  constructor(readonly now: () => Date = () => new Date()) {}

  create(input: {
    readonly id: string;
    readonly partnerId: string;
    readonly applicationId: string;
    readonly environment: CredentialEnvironment;
    readonly kind: CredentialKind;
    readonly scopes: readonly FineGrainedScope[];
    readonly constraints: CredentialConstraints;
    readonly expiresAt: string;
    readonly issuanceGate?: ProductionIssuanceGate;
    readonly rotationOf?: string;
  }): CredentialSecret {
    required(input.id, "credential id"); required(input.partnerId, "partnerId"); required(input.applicationId, "applicationId"); utc(input.expiresAt, "credential expiresAt");
    if (!/^[A-Za-z0-9.:-]+$/u.test(input.id)) throw new DeveloperPlatformError("VALIDATION_FAILED", "credential id contains a reserved delimiter");
    if (Date.parse(input.expiresAt) <= this.now().getTime()) throw new DeveloperPlatformError("VALIDATION_FAILED", "credential expiry must be in the future");
    validateScopes(input.scopes, input.partnerId); validateConstraints(input.constraints);
    if (input.environment === "production") validateProductionGate(input.issuanceGate);
    if (this.#credentials.has(input.id)) throw new DeveloperPlatformError("CONFLICT", "credential id already exists");
    if (input.rotationOf !== undefined) {
      const previous = this.#credential(input.rotationOf);
      if (previous.partnerId !== input.partnerId || previous.applicationId !== input.applicationId || previous.environment !== input.environment || previous.kind !== input.kind) throw new DeveloperPlatformError("CONFLICT", "rotation target does not match the new credential");
    }
    const secretValue = randomBytes(32).toString("base64url");
    const secret = `ltm_${input.environment}_${input.id}_${secretValue}`;
    const salt = randomBytes(16);
    const createdAt = this.now().toISOString();
    const stored: StoredCredential = {
      id: input.id, partnerId: input.partnerId, applicationId: input.applicationId, environment: input.environment, kind: input.kind,
      scopes: Object.freeze(input.scopes.map((scope) => Object.freeze(clone(scope)))), constraints: Object.freeze(clone(input.constraints)),
      createdAt, expiresAt: input.expiresAt, ...(input.rotationOf === undefined ? {} : { rotationOf: input.rotationOf }),
      salt, secretHash: hashSecret(secret, salt),
    };
    this.#credentials.set(input.id, stored);
    if (input.rotationOf !== undefined) this.revoke(input.rotationOf, "credential rotated");
    this.#audit.push(Object.freeze({ action: "credential.created", credentialId: input.id, partnerId: input.partnerId, at: createdAt }));
    return Object.freeze({ credentialId: input.id, secret, shownOnce: true });
  }

  authenticateSecret(secret: string, use: CredentialUse): AuthenticatedCredential {
    const match = /^ltm_(sandbox|staging|production)_([A-Za-z0-9.:-]+)_([A-Za-z0-9_-]{32,})$/u.exec(secret);
    if (match === null) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "credential format is invalid");
    const [, environment, credentialId] = match;
    const credential = this.#credential(credentialId as string);
    if (credential.environment !== environment || !timingSafeEqual(hashSecret(secret, credential.salt), credential.secretHash)) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "credential authentication failed");
    return this.#authorize(credential, use, credential.scopes);
  }

  issueAccessToken(input: { readonly clientSecret: string; readonly requestedScopes: readonly FineGrainedScope[]; readonly ttlSeconds: number }): CredentialSecret {
    const parsed = /^ltm_(sandbox|staging|production)_([A-Za-z0-9.:-]+)_([A-Za-z0-9_-]{32,})$/u.exec(input.clientSecret);
    const credentialId = parsed?.[2];
    if (credentialId === undefined) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "OAuth credential format is invalid");
    const credential = this.#credential(credentialId);
    if (credential.kind !== "oauth_client" && credential.kind !== "service_account") throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "credential cannot issue access tokens");
    if (!timingSafeEqual(hashSecret(input.clientSecret, credential.salt), credential.secretHash)) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "client authentication failed");
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 900) throw new DeveloperPlatformError("VALIDATION_FAILED", "access token lifetime must be 60 to 900 seconds");
    for (const requested of input.requestedScopes) if (!credential.scopes.some((granted) => sameScope(granted, requested))) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "requested token scope exceeds the client grant");
    const tokenId = randomBytes(12).toString("hex");
    const tokenValue = `ltm_access_${tokenId}_${randomBytes(32).toString("base64url")}`;
    const salt = randomBytes(16);
    const issuedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + input.ttlSeconds * 1000).toISOString();
    this.#tokens.set(tokenId, { tokenId, credentialId, tokenHash: hashSecret(tokenValue, salt), salt, scopes: Object.freeze(input.requestedScopes.map(clone)), issuedAt, expiresAt });
    return Object.freeze({ credentialId: tokenId, secret: tokenValue, shownOnce: true });
  }

  authenticateToken(token: string, use: CredentialUse): AuthenticatedCredential {
    const match = /^ltm_access_([a-f0-9]{24})_([A-Za-z0-9_-]{32,})$/u.exec(token);
    if (match === null) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "access token format is invalid");
    const stored = this.#tokens.get(match[1] as string);
    if (stored === undefined || !timingSafeEqual(hashSecret(token, stored.salt), stored.tokenHash) || Date.parse(stored.expiresAt) <= this.now().getTime()) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "access token is invalid or expired");
    return this.#authorize(this.#credential(stored.credentialId), use, stored.scopes);
  }

  revoke(credentialId: string, reason: string): void {
    required(reason, "revocation reason");
    const credential = this.#credential(credentialId);
    if (credential.revokedAt !== undefined) return;
    credential.revokedAt = this.now().toISOString();
    for (const [tokenId, token] of this.#tokens) if (token.credentialId === credentialId) this.#tokens.delete(tokenId);
    this.#audit.push(Object.freeze({ action: "credential.revoked", credentialId, partnerId: credential.partnerId, reason, at: credential.revokedAt }));
  }

  revokePartner(partnerId: string, reason: string): number {
    let count = 0;
    for (const credential of this.#credentials.values()) if (credential.partnerId === partnerId && credential.revokedAt === undefined) { this.revoke(credential.id, reason); count += 1; }
    return count;
  }

  scanLeak(text: string): readonly string[] {
    const leaked = [...this.#credentials.values()].filter((credential) => text.includes(`ltm_${credential.environment}_${credential.id}_`)).map((credential) => credential.id);
    for (const credentialId of leaked) this.revoke(credentialId, "credential prefix detected by leak scanner");
    return Object.freeze(leaked);
  }

  summary(credentialId: string): CredentialSummary {
    const { salt: _salt, secretHash: _hash, ...summary } = this.#credential(credentialId);
    return Object.freeze(clone(summary));
  }

  audit(partnerId: string): readonly Readonly<Record<string, string | number>>[] {
    return Object.freeze(this.#audit.filter((entry) => entry.partnerId === partnerId).map(clone));
  }

  #authorize(credential: StoredCredential, use: CredentialUse, scopes: readonly FineGrainedScope[]): AuthenticatedCredential {
    utc(this.now().toISOString()); required(use.nonce, "request nonce");
    if (credential.revokedAt !== undefined || Date.parse(credential.expiresAt) <= this.now().getTime()) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "credential is revoked or expired");
    if (credential.environment !== use.environment) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "credential environment mismatch");
    const scope = scopes.find((candidate) => candidate.resource === use.resource && candidate.action === use.action && candidate.tenantId === use.tenantId && candidate.purpose === use.purpose && candidate.dataCategories.includes(use.dataCategory) && (use.storeId === undefined || candidate.storeIds.includes(use.storeId)));
    if (scope === undefined) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "resource/action/tenant/store/purpose/data scope denied the request");
    checkConstraints(credential.constraints, use);
    const nowMs = this.now().getTime();
    const nonceKey = `${credential.id}:${use.nonce}`;
    if ((this.#nonces.get(nonceKey) ?? 0) > nowMs - 300_000) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "request replay detected");
    this.#nonces.set(nonceKey, nowMs);
    const minute = this.#usage.get(credential.id)?.filter((timestamp) => timestamp > nowMs - 60_000) ?? [];
    if (minute.length >= credential.constraints.ratePerMinute) throw new DeveloperPlatformError("RATE_LIMITED", "credential rate limit exceeded");
    minute.push(nowMs); this.#usage.set(credential.id, minute);
    if (!Number.isSafeInteger(use.costMinor) || use.costMinor < 0) throw new DeveloperPlatformError("VALIDATION_FAILED", "request cost must use non-negative minor units");
    const day = this.now().toISOString().slice(0, 10);
    const spend = this.#dailySpend.get(credential.id);
    const amountMinor = (spend?.day === day ? spend.amountMinor : 0) + use.costMinor;
    if (amountMinor > credential.constraints.budgetMinorPerDay) throw new DeveloperPlatformError("RATE_LIMITED", "credential daily budget exceeded");
    this.#dailySpend.set(credential.id, { day, amountMinor });
    credential.lastUsedAt = this.now().toISOString();
    this.#audit.push(Object.freeze({ action: "credential.used", credentialId: credential.id, partnerId: credential.partnerId, tenantId: use.tenantId, resource: use.resource, at: credential.lastUsedAt }));
    return Object.freeze({ credentialId: credential.id, partnerId: credential.partnerId, applicationId: credential.applicationId, scopes: Object.freeze(scopes.map(clone)) });
  }

  #credential(id: string): StoredCredential {
    const credential = this.#credentials.get(id);
    if (credential === undefined) throw new DeveloperPlatformError("NOT_FOUND", "credential does not exist");
    return credential;
  }
}

function hashSecret(secret: string, salt: Buffer): Buffer { return scryptSync(secret, salt, 32, { N: 16_384, r: 8, p: 1 }); }

function validateProductionGate(gate: ProductionIssuanceGate | undefined): void {
  if (gate === undefined || !gate.contractActive || !gate.applicationApproved || !gate.securityConfigurationApproved || new Set(gate.approverIds).size < 2) throw new DeveloperPlatformError("POLICY_BLOCKED", "production credential issuance requires contract, application, security, and two-person approvals");
  unique(gate.approverIds, "production credential approvers");
}

function validateScopes(scopes: readonly FineGrainedScope[], partnerId: string): void {
  if (scopes.length === 0) throw new DeveloperPlatformError("VALIDATION_FAILED", "credential requires at least one scope");
  const fingerprints = new Set<string>();
  for (const scope of scopes) {
    required(scope.resource, "scope resource"); required(scope.tenantId, "scope tenant"); required(scope.purpose, "scope purpose"); unique(scope.storeIds, "scope stores"); unique(scope.dataCategories, "scope data categories");
    if (scope.tenantId === "*" || scope.resource === "*" || scope.purpose === "*" || scope.dataCategories.includes("*") || scope.storeIds.includes("*")) throw new DeveloperPlatformError("POLICY_BLOCKED", "wildcard credential scopes are forbidden");
    if (!scope.tenantId.startsWith(`${partnerId}:`) && !scope.tenantId.startsWith("tenant-")) throw new DeveloperPlatformError("POLICY_BLOCKED", "credential tenant is outside the partner namespace");
    const value = digest(scope); if (fingerprints.has(value)) throw new DeveloperPlatformError("VALIDATION_FAILED", "credential scope is duplicated"); fingerprints.add(value);
  }
}

function validateConstraints(constraints: CredentialConstraints): void {
  if (constraints.ipCidrs.some((cidr) => !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u.test(cidr))) throw new DeveloperPlatformError("VALIDATION_FAILED", "credential IP constraint is invalid");
  if (constraints.allowedDomains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain))) throw new DeveloperPlatformError("VALIDATION_FAILED", "credential domain constraint is invalid");
  if (!Number.isSafeInteger(constraints.ratePerMinute) || constraints.ratePerMinute < 1 || !Number.isSafeInteger(constraints.budgetMinorPerDay) || constraints.budgetMinorPerDay < 0) throw new DeveloperPlatformError("VALIDATION_FAILED", "credential rate or budget constraint is invalid");
  if (constraints.mtlsCertificateSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(constraints.mtlsCertificateSha256)) throw new DeveloperPlatformError("VALIDATION_FAILED", "mTLS certificate digest is invalid");
  if (constraints.signingPublicKeyPem !== undefined) {
    const key = createPublicKey(constraints.signingPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new DeveloperPlatformError("VALIDATION_FAILED", "request signing key must be Ed25519");
  }
}

function checkConstraints(constraints: CredentialConstraints, use: CredentialUse): void {
  if (constraints.ipCidrs.length > 0 && !constraints.ipCidrs.some((cidr) => ipInCidr(use.sourceIp, cidr))) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "source IP is outside credential constraints");
  if (constraints.allowedDomains.length > 0 && (use.originDomain === undefined || !constraints.allowedDomains.includes(use.originDomain))) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "origin domain is outside credential constraints");
  if (constraints.mtlsCertificateSha256 !== undefined && constraints.mtlsCertificateSha256 !== use.mtlsCertificateSha256) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "mTLS certificate does not match");
  if (constraints.signingPublicKeyPem !== undefined && (use.requestSignature === undefined || !verify(null, use.requestBody, constraints.signingPublicKeyPem, use.requestSignature))) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "request signature is invalid");
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const toNumber = (value: string): number | undefined => {
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    return (((parts[0] as number) << 24) | ((parts[1] as number) << 16) | ((parts[2] as number) << 8) | (parts[3] as number)) >>> 0;
  };
  const ipNumber = toNumber(ip); const networkNumber = network === undefined ? undefined : toNumber(network);
  if (ipNumber === undefined || networkNumber === undefined || !Number.isInteger(prefix)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (networkNumber & mask);
}

function sameScope(left: FineGrainedScope, right: FineGrainedScope): boolean { return digest(left) === digest(right); }
