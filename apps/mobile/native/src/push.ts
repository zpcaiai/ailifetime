import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import type { EventSubscription } from "expo-modules-core";
import { validatePushPayload } from "../../src/production";
import type { RuntimeConfig } from "./runtime";
import { validateAppNavigation } from "./security";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export class PushCoordinator {
  constructor(private readonly config: RuntimeConfig, private readonly server: MobilePushServerPort) {}

  async enableByUserAction(): Promise<{ readonly registrationId: string }> {
    if (!Device.isDevice) throw new Error("PHYSICAL_DEVICE_REQUIRED_FOR_PUSH");
    const permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: false } });
    if (permission.status !== "granted") throw new Error("PUSH_PERMISSION_DENIED");
    const token = await Notifications.getExpoPushTokenAsync({ projectId: this.config.projectId });
    if (!/^ExponentPushToken\[[A-Za-z0-9_-]{10,}\]$/.test(token.data)) throw new Error("PUSH_TOKEN_INVALID");
    const result = await this.server.register({
      provider: "expo", token: token.data, environment: this.config.appEnvironment,
      idempotencyKey: `push-register:${this.config.projectId}`,
    });
    if (!plain(result) || !identifier(result.registrationId)) throw new Error("PUSH_REGISTRATION_INVALID");
    return { registrationId: result.registrationId };
  }

  async disable(registrationId: string): Promise<void> {
    if (!identifier(registrationId)) throw new Error("PUSH_REGISTRATION_ID_INVALID");
    await this.server.unregister({ registrationId, idempotencyKey: `push-delete:${registrationId}` });
  }

  listen(onRoute: (path: string) => void, onError: (error: Error) => void): EventSubscription {
    return Notifications.addNotificationResponseReceivedListener((response) => {
      void this.resolve(response.notification.request.content.data).then(onRoute).catch((error: unknown) => onError(asError(error)));
    });
  }

  async resolve(payload: unknown): Promise<string> {
    const reference = validatePushPayload(payload).navigationReference;
    const resolved = await this.server.resolveNavigation({ navigationReference: reference });
    if (!plain(resolved) || Object.keys(resolved).sort().join(",") !== "expiresAt,path" || typeof resolved.path !== "string" ||
        typeof resolved.expiresAt !== "string" || Date.parse(resolved.expiresAt) <= Date.now()) throw new Error("PUSH_NAVIGATION_INVALID");
    return validateAppNavigation(resolved.path);
  }
}

/**
 * Production composition must provide a tenant-bound implementation backed by
 * its authenticated push provider and opaque-navigation grant store. There is
 * deliberately no default HTTP path: an absent provider is a construction-time
 * dependency failure, never a synthetic registration success.
 */
export interface MobilePushServerPort {
  register(input: {
    readonly provider: "expo";
    readonly token: string;
    readonly environment: RuntimeConfig["appEnvironment"];
    readonly idempotencyKey: string;
  }): Promise<unknown>;
  unregister(input: { readonly registrationId: string; readonly idempotencyKey: string }): Promise<void>;
  resolveNavigation(input: { readonly navigationReference: string }): Promise<unknown>;
}

function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value); }
function plain(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error("PUSH_HANDLER_FAILED"); }
