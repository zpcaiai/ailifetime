import type { ConfigContext, ExpoConfig } from "expo/config";

const APPLICATION_IDS = {
  development: "com.ailifetime.mobile.dev",
  test: "com.ailifetime.mobile.test",
  staging: "com.ailifetime.mobile.staging",
  production: "com.ailifetime.mobile",
} as const;

export default ({ config }: ConfigContext): ExpoConfig => {
  const flavor = environment("MOBILE_FLAVOR", "development", Object.keys(APPLICATION_IDS)) as keyof typeof APPLICATION_IDS;
  const apiOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? (flavor === "development" ? "http://127.0.0.1:8080" : "");
  if (flavor !== "development" && !/^https:\/\/[a-z0-9.-]+$/.test(apiOrigin)) {
    throw new Error("EXPO_PUBLIC_API_ORIGIN must be an exact public HTTPS origin for non-development builds");
  }
  return {
    ...config,
    name: "生命时光机",
    slug: "ai-life-time-machine",
    version: "2.0.0",
    runtimeVersion: { policy: "appVersion" },
    orientation: "default",
    scheme: "ailtm",
    userInterfaceStyle: "automatic",
    ios: {
      bundleIdentifier: APPLICATION_IDS[flavor],
      supportsTablet: true,
      requireFullScreen: false,
      usesAppleSignIn: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: true,
        NSFaceIDUsageDescription: "用于确认仅由您访问安全会话和本地加密缓存。",
        UIBackgroundModes: ["fetch", "processing", "remote-notification"],
      },
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyAccessedAPITypes: [
          { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp", NSPrivacyAccessedAPITypeReasons: ["C617.1"] },
          { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] },
          { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime", NSPrivacyAccessedAPITypeReasons: ["35F9.1"] },
          { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace", NSPrivacyAccessedAPITypeReasons: ["E174.1"] }
        ],
        NSPrivacyCollectedDataTypes: [
          collected("NSPrivacyCollectedDataTypePhotosorVideos", ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]),
          collected("NSPrivacyCollectedDataTypeUserID", ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]),
          collected("NSPrivacyCollectedDataTypePurchaseHistory", ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]),
          collected("NSPrivacyCollectedDataTypeCrashData", ["NSPrivacyCollectedDataTypePurposeAnalytics"], false),
          collected("NSPrivacyCollectedDataTypePerformanceData", ["NSPrivacyCollectedDataTypePurposeAnalytics"], false)
        ]
      }
    },
    android: {
      package: APPLICATION_IDS[flavor],
      adaptiveIcon: { backgroundColor: "#12263a" },
      blockedPermissions: [
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.READ_CONTACTS",
        "android.permission.RECORD_AUDIO"
      ],
      permissions: ["android.permission.CAMERA", "android.permission.POST_NOTIFICATIONS"]
    },
    plugins: [
      "expo-router",
      ["expo-secure-store", { configureAndroidBackup: true, faceIDPermission: "允许生命时光机验证设备持有人以解锁安全会话。" }],
      ["expo-image-picker", {
        photosPermission: "仅在您选择创作素材时读取指定照片；不会扫描整个相册。",
        cameraPermission: "仅在您主动拍摄创作素材时使用相机。",
        microphonePermission: false
      }],
      ["expo-notifications", { enableBackgroundRemoteNotifications: true }],
      ["expo-sharing", {
        ios: { enabled: true, activationRule: { supportsImageWithMaxCount: 5, supportsMovieWithMaxCount: 1 } },
        android: { enabled: true, singleShareMimeTypes: ["image/jpeg", "image/png", "image/heic", "video/mp4"], multipleShareMimeTypes: ["image/jpeg", "image/png"] }
      }],
      ["expo-widgets", {
        bundleIdentifier: `${APPLICATION_IDS[flavor]}.widgets`,
        groupIdentifier: `group.${APPLICATION_IDS[flavor]}`,
        widgets: [{ name: "GenerationStatus", displayName: "生成进度", description: "仅显示您允许的最小任务状态。", contentMarginsDisabled: false, supportedFamilies: ["systemSmall", "accessoryRectangular"] }]
      }],
      "expo-local-authentication",
      "expo-iap",
      ["expo-build-properties", { ios: { deploymentTarget: "16.4", networkInspector: false }, android: { minSdkVersion: 26, compileSdkVersion: 36, targetSdkVersion: 36 } }]
    ],
    experiments: { typedRoutes: true },
    extra: {
      appEnvironment: flavor,
      apiOrigin,
      oidcIssuer: process.env.EXPO_PUBLIC_OIDC_ISSUER ?? "",
      oidcClientId: process.env.EXPO_PUBLIC_OIDC_CLIENT_ID ?? "",
      remoteConfigPublicKey: process.env.EXPO_PUBLIC_CONFIG_ED25519_KEY ?? "",
      remoteConfigDocument: process.env.EXPO_PUBLIC_CONFIG_DOCUMENT ?? "",
      remoteConfigSignature: process.env.EXPO_PUBLIC_CONFIG_SIGNATURE ?? "",
      apiPrimaryPins: process.env.EXPO_PUBLIC_API_PRIMARY_PINS ?? "",
      apiBackupPins: process.env.EXPO_PUBLIC_API_BACKUP_PINS ?? "",
      pinValidFrom: process.env.EXPO_PUBLIC_API_PIN_VALID_FROM ?? "",
      pinValidUntil: process.env.EXPO_PUBLIC_API_PIN_VALID_UNTIL ?? "",
      eas: { projectId: process.env.EXPO_PROJECT_ID ?? "" }
    },
    updates: { checkAutomatically: "ON_LOAD", fallbackToCacheTimeout: 0 }
  };
};

function environment(name: string, fallback: string, allowed: readonly string[]): string {
  const value = process.env[name] ?? fallback;
  if (!allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function collected(type: string, purposes: string[], linked = true) {
  return {
    NSPrivacyCollectedDataType: type,
    NSPrivacyCollectedDataTypeLinked: linked,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: purposes,
  };
}
