import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ServicesProvider } from "../src/services-context";

export default function RootLayout() {
  return <ServicesProvider><StatusBar style="auto" /><Stack screenOptions={{ headerBackTitle: "返回", animation: "fade" }}>
    <Stack.Screen name="index" options={{ title: "生命时光机" }} />
    <Stack.Screen name="capture" options={{ title: "选择素材" }} />
    <Stack.Screen name="editor" options={{ title: "创作设置" }} />
    <Stack.Screen name="job/[id]" options={{ title: "生成进度" }} />
    <Stack.Screen name="library" options={{ title: "我的作品" }} />
    <Stack.Screen name="account" options={{ title: "账户与隐私" }} />
  </Stack></ServicesProvider>;
}
