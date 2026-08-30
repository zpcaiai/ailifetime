import { Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, padding, privacySensitive } from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

export interface GenerationStatusProps {
  readonly state: "idle" | "queued" | "processing" | "ready" | "failed";
  readonly displayText: string;
  readonly updatedAt: string;
}

const GenerationStatus = (props: GenerationStatusProps, environment: WidgetEnvironment) => {
  "widget";
  return <VStack modifiers={[padding({ all: 12 }), privacySensitive()]}>
    <Text modifiers={[font({ weight: "bold", size: environment.widgetFamily === "accessoryRectangular" ? 13 : 16 }), foregroundStyle("#0b6b63")]}>生命时光机</Text>
    <Text>{props.displayText}</Text>
    <Text modifiers={[font({ size: 10 }), foregroundStyle("#526271")]}>{props.updatedAt}</Text>
  </VStack>;
};

export default createWidget("GenerationStatus", GenerationStatus);
