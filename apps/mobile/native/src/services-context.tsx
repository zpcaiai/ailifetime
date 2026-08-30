import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { MobileApiClient } from "./api-client";
import { registerUploadRecovery } from "./background";
import { EncryptedUploadSessionStore, createOfflineCache } from "./native-cache";
import { MobileObservability } from "./observability";
import { runtimeConfig, type RuntimeConfig } from "./runtime";
import { initializeTransportSecurity } from "./security";
import { OidcSessionManager, type VerifiedPrincipal } from "./session";

interface Services {
  readonly config: RuntimeConfig;
  readonly session: OidcSessionManager;
  readonly api: MobileApiClient;
  readonly principal: VerifiedPrincipal | null;
  readonly busy: boolean;
  readonly login: () => Promise<void>;
  readonly logout: () => Promise<void>;
}

const Context = createContext<Services | null>(null);

export function ServicesProvider({ children }: { readonly children: ReactNode }) {
  const [principal, setPrincipal] = useState<VerifiedPrincipal | null>(null);
  const [busy, setBusy] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const services = useMemo(() => {
    try {
      const config = runtimeConfig();
      const session = new OidcSessionManager(config);
      return { config, session, api: new MobileApiClient(config, session) };
    } catch (error) { setFatal(error instanceof Error ? error.message : "MOBILE_CONFIGURATION_FAILED"); return null; }
  }, []);

  useEffect(() => {
    if (services === null) return;
    let unlisten: () => void = () => undefined;
    let active = true;
    void (async () => {
      try {
        unlisten = await initializeTransportSecurity(services.config, () => setFatal("TLS_PIN_VALIDATION_FAILED"));
        await registerUploadRecovery();
        const restored = await services.session.restore();
        if (active) setPrincipal(restored);
        if (restored !== null) {
          const observability = new MobileObservability({ submit: (event) => services.api.request("/v1/mobile/telemetry", {
            purpose: "product_operation",
            idempotencyKey: `mobile-telemetry:${Crypto.randomUUID()}`,
            body: { eventId: `mobile-${Crypto.randomUUID()}`, name: event.name, occurredAt: new Date().toISOString(), fields: event.fields },
          }).then(() => undefined) });
          await observability.recordStartup("ready");
        }
      } catch (error) {
        if (active && error instanceof Error && error.message !== "OIDC_SESSION_RESTORE_FAILED") setFatal(error.message);
      } finally { if (active) setBusy(false); }
    })();
    return () => { active = false; unlisten(); };
  }, [services]);

  if (services === null || fatal !== null) return <View accessible accessibilityRole="alert" style={{ padding: 24 }}><Text>安全配置不可用：{fatal ?? "MOBILE_CONFIGURATION_FAILED"}</Text></View>;
  const value: Services = {
    ...services, principal, busy,
    login: async () => { setBusy(true); try { setPrincipal(await services.session.login()); } finally { setBusy(false); } },
    logout: async () => {
      setBusy(true);
      try {
        await services.session.logout();
        await createOfflineCache().purge();
        await new EncryptedUploadSessionStore().purgeAll();
        setPrincipal(null);
      } finally { setBusy(false); }
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useServices(): Services {
  const value = useContext(Context);
  if (value === null) throw new Error("MOBILE_SERVICES_UNAVAILABLE");
  return value;
}
