import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useServices } from "../src/services-context";

export default function Home() {
  const { principal, busy, login } = useServices();
  return <View style={styles.page}>
    <Text accessibilityRole="header" style={styles.title}>把珍贵时刻变成可控的艺术想象</Text>
    <Text style={styles.body}>生成内容是 AI 艺术创作，不是年龄、健康或身份预测。每位人物都需要授权，作品默认私密且可撤销。</Text>
    {principal === null
      ? <Pressable accessibilityRole="button" accessibilityLabel="使用安全登录" disabled={busy} style={styles.button} onPress={() => void login()}><Text style={styles.buttonText}>{busy ? "正在恢复安全会话…" : "安全登录"}</Text></Pressable>
      : <><Text style={styles.status}>服务端身份已验证 · {principal.tenantId}</Text><Link href="/capture" asChild><Pressable accessibilityRole="button" style={styles.button}><Text style={styles.buttonText}>开始创作</Text></Pressable></Link></>}
    <View style={styles.row}><Link href="/library">作品库</Link><Link href="/account">账户与隐私</Link></View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, gap: 20, backgroundColor: "#f4f7fa" },
  title: { fontSize: 30, lineHeight: 38, fontWeight: "700", color: "#12263a" },
  body: { fontSize: 17, lineHeight: 26, color: "#526271" },
  status: { fontSize: 16, color: "#0b6b63" },
  button: { padding: 16, borderRadius: 12, backgroundColor: "#0b6b63", alignItems: "center" },
  buttonText: { color: "white", fontSize: 18, fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 24 },
});
