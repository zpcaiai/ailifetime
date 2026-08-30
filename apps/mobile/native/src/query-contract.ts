export interface MobileLibraryItem {
  readonly id: string;
  readonly state: string;
  readonly aiLabel: "AI 生成艺术内容";
}

export function parseLibraryRecords(value: unknown): readonly MobileLibraryItem[] {
  if (!Array.isArray(value)) throw new Error("MOBILE_LIBRARY_RESPONSE_INVALID");
  return value.map((record) => {
    const parsed = generationRecord(record, "MOBILE_LIBRARY_RESPONSE_INVALID");
    return Object.freeze({ id: parsed.id, state: serverState(parsed.data), aiLabel: "AI 生成艺术内容" as const });
  });
}

export function parseGenerationJob(value: unknown, expectedJobId: string): { readonly state: string } {
  const parsed = generationRecord(value, "GENERATION_JOB_RESPONSE_INVALID");
  if (parsed.id !== expectedJobId || parsed.data.jobId !== expectedJobId) throw new Error("GENERATION_JOB_BINDING_INVALID");
  return Object.freeze({ state: serverState(parsed.data) });
}

function generationRecord(value: unknown, code: string): { readonly id: string; readonly data: Record<string, any> } {
  if (!plain(value) || !identifier(value.id) || value.collection !== "generation.timeline-commands" || !plain(value.data) ||
      value.data.batchId !== "B14" || value.data.operation !== "createTimeline" || value.data.illustrativeLabel !== true ||
      !identifier(value.data.jobId) || value.id !== value.data.jobId) {
    throw new Error(code);
  }
  return { id: value.id, data: value.data };
}

function serverState(data: Record<string, any>): string {
  const value = data.commandState ?? data.state ?? data.executionState;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(value)) throw new Error("GENERATION_JOB_STATE_INVALID");
  return value;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(value);
}
function plain(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
