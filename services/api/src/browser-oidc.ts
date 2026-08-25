import { DomainError } from "@ltm/core";

export interface BrowserOidcPublicConfiguration {
  readonly schemaVersion: "ltm.browser-oidc-config.v1";
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly audience: string;
}

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,127}$/;

export function configuredBrowserOidc(
  environment: NodeJS.ProcessEnv,
  appEnvironment: string,
  authMode: string,
  staticFilesEnabled: boolean,
): BrowserOidcPublicConfiguration | undefined {
  const names = [
    "LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT",
    "LTM_WEB_OIDC_TOKEN_ENDPOINT",
    "LTM_WEB_OIDC_CLIENT_ID",
    "LTM_WEB_OIDC_REDIRECT_URI",
    "LTM_WEB_OIDC_SCOPES",
  ] as const;
  const configured = names.filter((name) => (environment[name]?.trim().length ?? 0) > 0);
  const required = appEnvironment === "production" && authMode === "oidc" && staticFilesEnabled;
  if (!required && configured.length === 0) return undefined;
  if (authMode !== "oidc") {
    throw new DomainError("CONFIGURATION_INVALID", "Browser OIDC requires LTM_AUTH_MODE=oidc");
  }
  if (configured.length !== names.length) {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      `Browser OIDC must configure all of ${names.join(", ")}`,
    );
  }

  const issuer = strictHttpsUrl(environment.LTM_OIDC_ISSUER, "LTM_OIDC_ISSUER", true);
  const authorizationEndpoint = strictHttpsUrl(
    environment.LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT,
    "LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT",
    false,
  );
  const tokenEndpoint = strictHttpsUrl(
    environment.LTM_WEB_OIDC_TOKEN_ENDPOINT,
    "LTM_WEB_OIDC_TOKEN_ENDPOINT",
    false,
  );
  if (
    authorizationEndpoint.origin !== issuer.origin
    || tokenEndpoint.origin !== issuer.origin
    || !withinIssuerPath(authorizationEndpoint, issuer)
    || !withinIssuerPath(tokenEndpoint, issuer)
  ) {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "Browser OIDC authorization and token endpoints must share the trusted issuer origin",
    );
  }
  const redirectUri = strictHttpsUrl(environment.LTM_WEB_OIDC_REDIRECT_URI, "LTM_WEB_OIDC_REDIRECT_URI", false);
  if (redirectUri.pathname === "/" || redirectUri.search !== "" || redirectUri.hash !== "") {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "LTM_WEB_OIDC_REDIRECT_URI must be an exact HTTPS callback URI without query or fragment",
    );
  }
  if (appEnvironment === "production") {
    const publicBase = strictHttpsUrl(environment.LTM_PUBLIC_BASE_URL, "LTM_PUBLIC_BASE_URL", true);
    if (publicBase.pathname !== "/" || publicBase.search !== "" || publicBase.hash !== "") {
      throw new DomainError("CONFIGURATION_INVALID", "LTM_PUBLIC_BASE_URL must be an exact HTTPS origin");
    }
    const expectedRedirect = new URL("/auth/callback", publicBase).toString();
    if (redirectUri.toString() !== expectedRedirect) {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "LTM_WEB_OIDC_REDIRECT_URI must exactly equal LTM_PUBLIC_BASE_URL plus /auth/callback",
      );
    }
  }
  const clientId = bounded(environment.LTM_WEB_OIDC_CLIENT_ID, "LTM_WEB_OIDC_CLIENT_ID", 256);
  if (!CLIENT_ID.test(clientId)) {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_WEB_OIDC_CLIENT_ID is invalid");
  }
  const scopes = parseScopes(environment.LTM_WEB_OIDC_SCOPES);
  const audience = bounded(environment.LTM_OIDC_AUDIENCE, "LTM_OIDC_AUDIENCE", 512);
  return Object.freeze({
    schemaVersion: "ltm.browser-oidc-config.v1",
    issuer: issuer.toString(),
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    clientId,
    redirectUri: redirectUri.toString(),
    scopes: Object.freeze(scopes),
    audience,
  });
}

function withinIssuerPath(endpoint: URL, issuer: URL): boolean {
  return issuer.pathname === "/" || endpoint.pathname.startsWith(issuer.pathname);
}

function parseScopes(value: string | undefined): readonly string[] {
  const scopes = bounded(value, "LTM_WEB_OIDC_SCOPES", 1_024).split(/\s+/);
  if (scopes.length === 0 || scopes.length > 20 || new Set(scopes).size !== scopes.length || scopes.some((scope) => !SCOPE.test(scope))) {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_WEB_OIDC_SCOPES must be a bounded unique space-separated scope list");
  }
  if (!scopes.includes("openid")) {
    throw new DomainError("CONFIGURATION_INVALID", "LTM_WEB_OIDC_SCOPES must include openid");
  }
  if (scopes.includes("offline_access")) {
    throw new DomainError("CONFIGURATION_INVALID", "Browser OIDC must not request offline_access or browser refresh tokens");
  }
  return scopes;
}

function strictHttpsUrl(value: string | undefined, label: string, issuer: boolean): URL {
  const normalized = bounded(value, label, 1_024);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be a valid HTTPS URL`);
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.hostname === "localhost"
    || url.hostname.endsWith(".localhost")
    || url.hostname === "127.0.0.1"
    || url.hostname === "::1"
    || (!issuer && (url.pathname === "/" || url.search !== ""))
    || (issuer && url.search !== "")
  ) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be a credential-free public HTTPS URL`);
  }
  if (issuer && !url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function bounded(value: string | undefined, label: string, maximum: number): string {
  if (
    value === undefined
    || value.trim() !== value
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be a bounded visible value`);
  }
  return value;
}
