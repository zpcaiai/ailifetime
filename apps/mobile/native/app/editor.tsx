import * as Crypto from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { NativeUploadService } from "../src/upload";
import { useServices } from "../src/services-context";
import { validatePrivateMediaUri } from "../src/security";

export default function EditorScreen() {
  const params = useLocalSearchParams<{ uri?: string }>();
  const { api, principal } = useServices();
  const [age, setAge] = useState("30");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    try {
      if (principal === null || typeof params.uri !== "string") throw new Error("AUTHENTICATION_REQUIRED");
      const uri = validatePrivateMediaUri(params.uri);
      const targetAge = Number(age);
      if (!Number.isSafeInteger(targetAge) || targetAge < 1 || targetAge > 100 || !accepted) throw new Error("DISCLOSURE_AND_TARGET_AGE_REQUIRED");
      const upload = new NativeUploadService(api);
      const key = `mobile-upload:${Crypto.randomUUID()}`;
      const state = await upload.begin(uri, { tenantId: principal.tenantId, actorId: principal.actorId, purpose: "age_transformation" }, key);
      const completed = await upload.resume(state.uploadId, { tenantId: principal.tenantId, actorId: principal.actorId, purpose: "age_transformation" }, false);
      if (completed.state !== "server_validation_pending") throw new Error("UPLOAD_NOT_COMPLETED");
      const intake = await api.requestData<unknown>("/v1/capabilities/B07", {
        purpose: "age_transformation", idempotencyKey: `mobile-intake:${Crypto.randomUUID()}`,
        body: { input: { assetId: completed.assetId, participantIds: [principal.actorId] } },
      });
      if (!plain(intake) || intake.batchId !== "B07" || intake.recordId !== completed.assetId || intake.state !== "persisted") {
        throw new Error("MEDIA_INTAKE_RESPONSE_INVALID");
      }
      const jobId = `mobile-${Crypto.randomUUID()}`;
      const command = await api.requestData<unknown>("/v1/capabilities/B14", {
        purpose: "age_transformation", idempotencyKey: `mobile-generate:${Crypto.randomUUID()}`,
        body: { input: {
          jobId, sourceAssetId: completed.assetId, participantIds: [principal.actorId], targetAges: [0, targetAge],
          seed: Crypto.randomUUID(), promptPolicyVersion: "mobile-prompt-v1", illustrativeLabel: true,
        } },
      });
      if (!plain(command) || command.batchId !== "B14" || command.recordId !== jobId || command.commandState !== "requested" ||
          typeof command.externalCommandId !== "string") throw new Error("GENERATION_JOB_INVALID");
      router.replace({ pathname: "/job/[id]", params: { id: jobId } });
    } catch (value) { setError(value instanceof Error ? value.message : "GENERATION_FAILED"); }
  }
  return <View style={styles.page}><Text>逐人授权凭据由服务端核验；客户端不能自报授权或绕过质量复核。</Text>
    <TextInput accessibilityLabel="目标年龄" keyboardType="number-pad" value={age} onChangeText={setAge} style={styles.input} />
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: accepted }} style={styles.check} onPress={() => setAccepted(!accepted)}><Text>{accepted ? "☑" : "☐"} 我理解这是带 AI 标识的艺术化效果，不是预测；并接受当前保存期限。</Text></Pressable>
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => void submit()}><Text style={styles.buttonText}>上传并提交服务端复核</Text></Pressable>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>;
}
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const styles = StyleSheet.create({ page: { padding: 24, gap: 18 }, input: { borderWidth: 1, borderColor: "#9aa8b2", padding: 14, borderRadius: 10, fontSize: 18 }, check: { padding: 14, backgroundColor: "#eef5fa", borderRadius: 10 }, button: { padding: 14, borderRadius: 10, backgroundColor: "#0b6b63", alignItems: "center" }, buttonText: { color: "white", fontWeight: "600" }, error: { color: "#8b1e2b" } });
