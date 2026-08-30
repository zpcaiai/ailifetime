import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import type { AccessTokenProvider } from "./api-client";
import type { RuntimeConfig } from "./runtime";
import { parseServerSession, type VerifiedPrincipal } from "./session-contract";

export type { VerifiedPrincipal } from "./session-contract";

WebBrowser.maybeCompleteAuthSession();

const REFRESH_KEY = "ltm.mobile.oidc.refresh.v1";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  keychainService: "ltm.mobile.oidc",
};

interface MemoryTokens {
  readonly accessToken: string;
  readonly expiresAtMs: number;
  readonly refreshToken: string;
  readonly principal: VerifiedPrincipal;
}

export class OidcSessionManager implements AccessTokenProvider {
  #tokens: MemoryTokens | undefined;
  #refreshing: Promise<MemoryTokens> | undefined;

  constructor(private readonly config: RuntimeConfig, private readonly fetcher: typeof fetch = fetch) {}

  get principal(): VerifiedPrincipal | null { return this.#tokens?.principal ?? null; }

  async login(): Promise<VerifiedPrincipal> {
    const discovery = await AuthSession.fetchDiscoveryAsync(this.config.oidcIssuer);
    const redirectUri = AuthSession.makeRedirectUri({ scheme: "ailtm", path: "auth/callback" });
    const request = new AuthSession.AuthRequest({
      clientId: this.config.oidcClientId,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      scopes: ["openid", "profile", "offline_access"],
      usePKCE: true,
      prompt: AuthSession.Prompt.Login,
    });
    const result = await request.promptAsync(discovery);
    if (result.type !== "success" || typeof result.params.code !== "string" || result.params.code.length < 8 || request.codeVerifier === undefined) {
      throw new Error(result.type === "cancel" || result.type === "dismiss" ? "OIDC_USER_CANCELLED" : "OIDC_AUTHORIZATION_FAILED");
    }
    const response = await AuthSession.exchangeCodeAsync({
      clientId: this.config.oidcClientId,
      code: result.params.code,
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier },
    }, discovery);
    const tokens = await this.acceptTokenResponse(response.accessToken, response.refreshToken, response.expiresIn);
    return tokens.principal;
  }

  async restore(): Promise<VerifiedPrincipal | null> {
    const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTIONS);
    if (refreshToken === null) return null;
    try { return (await this.refresh(refreshToken)).principal; }
    catch (error) {
      await this.invalidate();
      throw new Error("OIDC_SESSION_RESTORE_FAILED", { cause: error });
    }
  }

  async accessToken(): Promise<string> {
    const current = this.#tokens;
    if (current !== undefined && current.expiresAtMs > Date.now() + 60_000) return current.accessToken;
    const refreshToken = current?.refreshToken ?? await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTIONS);
    if (refreshToken === null) throw new Error("AUTHENTICATION_REQUIRED");
    this.#refreshing ??= this.refresh(refreshToken).finally(() => { this.#refreshing = undefined; });
    return (await this.#refreshing).accessToken;
  }

  async logout(): Promise<void> {
    const refreshToken = this.#tokens?.refreshToken ?? await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTIONS);
    try {
      if (refreshToken !== null) {
        const discovery = await AuthSession.fetchDiscoveryAsync(this.config.oidcIssuer);
        if (typeof discovery.revocationEndpoint === "string") {
          await AuthSession.revokeAsync({ token: refreshToken, clientId: this.config.oidcClientId }, discovery);
        }
      }
    } catch { /* IdP revocation is best-effort; device credentials are still deleted below. */ }
    finally { await this.invalidate(); }
  }

  async invalidate(): Promise<void> {
    this.#tokens = undefined;
    await SecureStore.deleteItemAsync(REFRESH_KEY, STORE_OPTIONS);
  }

  private async refresh(refreshToken: string): Promise<MemoryTokens> {
    if (!tokenShape(refreshToken)) throw new Error("OIDC_REFRESH_TOKEN_INVALID");
    const discovery = await AuthSession.fetchDiscoveryAsync(this.config.oidcIssuer);
    const response = await AuthSession.refreshAsync({ clientId: this.config.oidcClientId, refreshToken }, discovery);
    return this.acceptTokenResponse(response.accessToken, response.refreshToken ?? refreshToken, response.expiresIn);
  }

  private async acceptTokenResponse(accessToken: string, refreshToken: string | undefined, expiresIn: number | undefined): Promise<MemoryTokens> {
    if (!tokenShape(accessToken) || !tokenShape(refreshToken) || !Number.isSafeInteger(expiresIn) || expiresIn! < 60 || expiresIn! > 86_400) {
      throw new Error("OIDC_TOKEN_RESPONSE_INVALID");
    }
    const principal = await this.bindServerPrincipal(accessToken);
    const tokens: MemoryTokens = { accessToken, refreshToken, expiresAtMs: Date.now() + expiresIn! * 1_000, principal };
    await SecureStore.setItemAsync(REFRESH_KEY, refreshToken, STORE_OPTIONS);
    this.#tokens = tokens;
    return tokens;
  }

  private async bindServerPrincipal(accessToken: string): Promise<VerifiedPrincipal> {
    const response = await this.fetcher(`${this.config.apiOrigin}/v1/session`, {
      method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "X-Purpose": "product_operation" },
      credentials: "omit", redirect: "error",
    });
    if (!response.ok) throw new Error(`SESSION_HTTP_${response.status}`);
    if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("SERVER_SESSION_CONTENT_TYPE_INVALID");
    const value: unknown = await response.json();
    return parseServerSession(value);
  }
}

function tokenShape(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= 20 && value.length <= 16_384 && !/[\u0000-\u001f\u007f]/.test(value);
}
