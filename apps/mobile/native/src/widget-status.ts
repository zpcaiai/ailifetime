import GenerationStatus from "../widgets/GenerationStatus";

const DISPLAY: Record<string, string> = { idle: "暂无任务", queued: "已排队", processing: "正在生成", ready: "作品已完成", failed: "任务未完成" };

export function updateGenerationWidget(state: "idle" | "queued" | "processing" | "ready" | "failed", at = new Date()): void {
  if (!Number.isFinite(at.getTime())) throw new Error("WIDGET_TIMESTAMP_INVALID");
  GenerationStatus.updateSnapshot({ state, displayText: DISPLAY[state]!, updatedAt: at.toISOString().slice(11, 16) });
}

export function clearGenerationWidget(): void { updateGenerationWidget("idle"); }
