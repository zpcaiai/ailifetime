import { Pressable, StyleSheet, Text, View } from "react-native";
import { useServices } from "../src/services-context";

export default function AccountScreen() {
  const { principal, busy, login, logout } = useServices();
  return <View style={styles.page}><Text accessibilityRole="header" style={styles.title}>账户与隐私</Text>
    <Text>{principal === null ? "未登录" : `服务端验证账户 ${principal.actorId}`}</Text>
    <Text>退出会撤销本机会话并清除加密缓存和待上传素材。删除账户和数据导出请求由服务端权利工作流处理。</Text>
    <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => void (principal === null ? login() : logout())}><Text style={styles.buttonText}>{principal === null ? "安全登录" : "退出并清除本机数据"}</Text></Pressable>
  </View>;
}
const styles = StyleSheet.create({ page: { padding: 24, gap: 18 }, title: { fontSize: 26, fontWeight: "700" }, button: { padding: 14, borderRadius: 10, backgroundColor: "#0b6b63", alignItems: "center" }, buttonText: { color: "white", fontWeight: "600" } });
