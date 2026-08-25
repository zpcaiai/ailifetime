# Application surfaces

`web` is the runnable browser surface. It exposes seven role-aware portals that cover all 22 skill workspaces and the complete B00-B127 catalog through one shared shell. Its production login is a public OIDC Authorization Code + PKCE S256 client: only a five-minute one-time state/verifier transaction is persisted, tokens remain memory-only, and the API's JWT/JWKS-verified `/v1/session` projection is authoritative. The IdP registration must use the exact `/auth/callback` URI and allow the web origin to call its token endpoint through CORS; no client secret or refresh token belongs in the SPA.

`mobile` contains the framework-neutral security core plus an executable HTTP application state machine: native OIDC injection, in-memory bearer handling, server session/visible-capability double validation, tenant/actor-bound offline replay and fail-closed navigation/dispatch. `wechat-mini` contains the shared commerce controls and a complete native mini-program project with login, consent-bound media capture, resumable upload, generation, status, private library, revocation and support pages. Both clients consume server-authorized projections; neither invents tenant, role, payment, provider-result or sharing authority.

They are not signed iOS, Android or WeChat release artifacts. A production release must bind the mobile state machine to approved native UI/secure-storage/identity ports, enroll the real mini-program app ID and broker domains, run platform/device tests, produce signed builds and retain the Apple, Google and WeChat review decisions required by the B127 manifest.

The release mini-program additionally requires canonical `apiBaseUrl` and
`apiAllowedOrigins` extension configuration. Each allowlisted value must be an
exact public HTTPS origin without credentials, path, query, fragment, IP
literal, loopback, or reserved test suffix; startup fails closed when the
configured API origin is not enrolled.
