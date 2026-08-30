import * as Application from "expo-application";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { safeOperationalEvent } from "../../src/production";

export interface TelemetrySink {
  submit(event: { readonly name: string; readonly fields: Readonly<Record<string, string | number | boolean>> }): Promise<void>;
}

const bootStartedAt = Date.now();

export class MobileObservability {
  constructor(private readonly sink: TelemetrySink) {}

  async recordStartup(status: "ready" | "failed"): Promise<void> {
    await this.sink.submit(safeOperationalEvent("mobile.startup", {
      platform: Platform.OS,
      appVersion: Application.nativeApplicationVersion ?? "unknown",
      status,
      durationMs: Date.now() - bootStartedAt,
    }));
  }

  async recordNetwork(operation: string, status: "ok" | "failed", durationMs: number, errorCode = "none"): Promise<void> {
    await this.sink.submit(safeOperationalEvent("mobile.network", { platform: Platform.OS, operation, status, durationMs, errorCode }));
  }

  async recordCrash(error: unknown): Promise<void> {
    const errorCode = error instanceof Error && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(error.name) ? error.name : "UnhandledError";
    await this.sink.submit(safeOperationalEvent("mobile.crash", {
      platform: Platform.OS, appVersion: Application.nativeApplicationVersion ?? "unknown", status: "failed", errorCode,
    }));
  }

  static deviceBuildSignal(): { readonly physical: boolean; readonly platform: string; readonly os: string } {
    return { physical: Device.isDevice, platform: Platform.OS, os: Device.osName ?? "unknown" };
  }
}
