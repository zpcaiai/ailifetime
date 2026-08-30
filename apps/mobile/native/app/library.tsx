import { useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useServices } from "../src/services-context";
import { parseLibraryRecords, type MobileLibraryItem } from "../src/query-contract";

export default function LibraryScreen() {
  const { api, principal } = useServices();
  const [items, setItems] = useState<readonly MobileLibraryItem[]>([]);
  useEffect(() => { if (principal === null) return; void api.query<unknown>(
    "record.list", { collection: "generation.timeline-commands", limit: 50 }, "age_transformation",
  ).then((value) => setItems(parseLibraryRecords(value))).catch(() => setItems([])); }, [api, principal]);
  return <FlatList contentContainerStyle={{ padding: 24, gap: 14 }} data={items} keyExtractor={(item) => item.id} ListEmptyComponent={<Text>离线或暂无可验证作品。</Text>} renderItem={({ item }) => <View accessible accessibilityLabel={`${item.aiLabel}，状态 ${item.state}`}><Text>{item.aiLabel}</Text><Text>{item.state}</Text></View>} />;
}
