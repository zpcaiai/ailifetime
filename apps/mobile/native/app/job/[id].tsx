import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, Text, View } from "react-native";
import { useServices } from "../../src/services-context";
import { parseGenerationJob } from "../../src/query-contract";

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useServices();
  const [status, setStatus] = useState("等待服务端处理");
  useEffect(() => {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(id)) { setStatus("任务引用无效"); return; }
    let active = true;
    const refresh = () => void api.query<unknown>("record.get", {
      collection: "generation.timeline-commands", id,
    }, "age_transformation").then((value) => {
      if (!active) return;
      const label = states[parseGenerationJob(value, id).state] ?? "等待服务端确认";
      setStatus(label); void AccessibilityInfo.announceForAccessibility(label);
    }).catch(() => { if (active) setStatus("网络不可用，将自动重试"); });
    refresh();
    const timer = setInterval(refresh, 4_000);
    return () => { active = false; clearInterval(timer); };
  }, [api, id]);
  return <View style={styles.page}><Text accessibilityRole="header" style={styles.title}>生成任务</Text><Text accessibilityLiveRegion="polite">{status}</Text><Text>客户端不会根据本地计时伪造成功，最终状态必须来自服务端投影。</Text></View>;
}
const states: Record<string, string> = {
  requested: "已提交，等待服务端派发", dispatched: "已派发", acknowledged: "正在生成", succeeded: "已完成，带 AI 标识",
  failed: "生成失败", quarantined: "结果待人工复核", cancelled: "已取消",
};
const styles = StyleSheet.create({ page: { padding: 24, gap: 18 }, title: { fontSize: 26, fontWeight: "700" } });
