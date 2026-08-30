import { useIncomingShare } from "expo-sharing";
import { router } from "expo-router";
import { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { captureAndNormalize, type NormalizedCapture, useNativeFaceQuality } from "../src/capture";

export default function CaptureScreen() {
  const incoming = useIncomingShare();
  const [capture, setCapture] = useState<NormalizedCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const faceQuality = useNativeFaceQuality(capture?.uri, capture?.width ?? 0, capture?.height ?? 0);
  async function choose(source: "camera" | "library") {
    setError(null);
    try { setCapture(await captureAndNormalize(source)); } catch (value) { setError(value instanceof Error ? value.message : "CAPTURE_FAILED"); }
  }
  return <ScrollView contentContainerStyle={styles.page}>
    <Text>只处理您主动选择的照片。HEIC/HEIF 会在设备上校正方向、裁剪并重编码为去元数据 JPEG。</Text>
    {incoming.resolvedSharedPayloads.length > 0 && <Text accessibilityRole="alert">检测到 {incoming.resolvedSharedPayloads.length} 个系统分享素材；确认授权后再导入。</Text>}
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => void choose("camera")}><Text style={styles.buttonText}>拍摄照片</Text></Pressable>
    <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void choose("library")}><Text>从相册选择</Text></Pressable>
    {capture && <><Image accessibilityLabel="已规范化的照片预览" source={{ uri: capture.uri }} style={styles.image} resizeMode="contain" />
      <Text>亮度 {capture.meanLuminance.toFixed(0)} · 清晰度 {capture.laplacianVariance.toFixed(0)} · 人脸 {faceQuality.faces.length}</Text>
      <Text>服务端仍会重新校验质量、人物与逐人授权，本地结果不构成通过。</Text>
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => router.push({ pathname: "/editor", params: { uri: capture.uri } })}><Text style={styles.buttonText}>确认人物与授权</Text></Pressable></>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </ScrollView>;
}
const styles = StyleSheet.create({ page: { padding: 24, gap: 16 }, button: { padding: 14, borderRadius: 10, backgroundColor: "#0b6b63", alignItems: "center" }, buttonText: { color: "white", fontWeight: "600" }, secondary: { padding: 14, borderRadius: 10, backgroundColor: "#e7f2f0", alignItems: "center" }, image: { width: "100%", height: 360 }, error: { color: "#8b1e2b" } });
