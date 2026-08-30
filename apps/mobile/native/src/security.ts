import * as ScreenCapture from "expo-screen-capture";
import { addSslPinningErrorListener, initializeSslPinning, isSslPinningAvailable } from "react-native-ssl-public-key-pinning";
import type { RuntimeConfig } from "./runtime";

let initializedHost: string | undefined;

export async function initializeTransportSecurity(config: RuntimeConfig, onPinFailure: (host: string) => void): Promise<() => void> {
  if (!isSslPinningAvailable()) {
    if (config.appEnvironment !== "development") throw new Error("NATIVE_TLS_PINNING_UNAVAILABLE");
    return () => undefined;
  }
  if (initializedHost !== undefined && initializedHost !== config.apiHost) throw new Error("TLS_PINNING_ALREADY_BOUND");
  await initializeSslPinning({
    [config.apiHost]: {
      includeSubdomains: false,
      publicKeyHashes: [...config.apiPrimaryPins, ...config.apiBackupPins],
      expirationDate: config.pinValidUntil.slice(0, 10),
    },
  });
  initializedHost = config.apiHost;
  const listener = addSslPinningErrorListener((failure) => {
    if (failure.serverHostname === config.apiHost) onPinFailure(config.apiHost);
  });
  return () => listener.remove();
}

export async function protectSensitiveScreen(key = "ltm-sensitive-content"): Promise<() => Promise<void>> {
  if (!(await ScreenCapture.isAvailableAsync())) throw new Error("SCREEN_CAPTURE_PROTECTION_UNAVAILABLE");
  await ScreenCapture.preventScreenCaptureAsync(key);
  await ScreenCapture.enableAppSwitcherProtectionAsync(0.85);
  return async () => {
    await ScreenCapture.disableAppSwitcherProtectionAsync();
    await ScreenCapture.allowScreenCaptureAsync(key);
  };
}

export function validatePrivateMediaUri(value: string): string {
  if (!/^(?:file|content):\/\/[A-Za-z0-9%+.,_~:/=@-]{1,2048}$/.test(value) || /\.\.(?:\/|%2f)/i.test(value)) {
    throw new Error("PRIVATE_MEDIA_URI_INVALID");
  }
  return value;
}

export function validateAppNavigation(value: string): string {
  if (!/^\/(?:capture|editor|job|library|account)(?:\/[A-Za-z0-9._:-]{1,128})?$/.test(value)) {
    throw new Error("APP_NAVIGATION_FORBIDDEN");
  }
  return value;
}
