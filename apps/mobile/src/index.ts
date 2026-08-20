export interface CapabilityExecutor {
  execute<T>(batchId: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<T>;
}

export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OfflineCommand {
  id: string;
  batchId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export class MobileOfflineQueue {
  constructor(private readonly storage: SecureStorage, private readonly storageKey = "ltm.offline.commands") {}

  async enqueue(command: OfflineCommand): Promise<void> {
    validateCommand(command);
    const commands = await this.read();
    if (commands.some((item) => item.id === command.id || item.idempotencyKey === command.idempotencyKey)) return;
    commands.push(structuredClone(command));
    await this.storage.set(this.storageKey, JSON.stringify(commands));
  }

  async flush(client: CapabilityExecutor, now = new Date()): Promise<{ sent: string[]; retained: string[] }> {
    const commands = await this.read();
    const retained: OfflineCommand[] = [];
    const sent: string[] = [];
    for (const command of commands) {
      if (new Date(command.expiresAt).getTime() <= now.getTime()) continue;
      try {
        await client.execute(command.batchId, command.payload, command.idempotencyKey);
        sent.push(command.id);
      } catch {
        retained.push(command);
      }
    }
    if (retained.length === 0) await this.storage.delete(this.storageKey);
    else await this.storage.set(this.storageKey, JSON.stringify(retained));
    return { sent, retained: retained.map((item) => item.id) };
  }

  async purge(): Promise<void> {
    await this.storage.delete(this.storageKey);
  }

  private async read(): Promise<OfflineCommand[]> {
    const raw = await this.storage.get(this.storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("offline queue is corrupted");
    return parsed.map((entry) => {
      validateCommand(entry);
      return entry;
    });
  }
}

export function authorizeMobileDeepLink(raw: string, allowedHosts: readonly string[]): { path: string; query: URLSearchParams } {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) throw new Error("deep link origin is not allowed");
  const allowedPaths = [/^\/projects\/[A-Za-z0-9_-]+$/, /^\/jobs\/[A-Za-z0-9_-]+$/, /^\/library$/, /^\/consent\/[A-Za-z0-9_-]+$/];
  if (!allowedPaths.some((pattern) => pattern.test(url.pathname))) throw new Error("deep link path is not allowed");
  for (const forbidden of ["token", "role", "tenant", "price", "consent"]) {
    if (url.searchParams.has(forbidden)) throw new Error(`deep link cannot assert ${forbidden}`);
  }
  return { path: url.pathname, query: new URLSearchParams(url.searchParams) };
}

export function preflightMobileCapture(input: { mimeType: string; byteLength: number; width: number; height: number }): { accepted: true; warnings: string[] } {
  if (!new Set(["image/jpeg", "image/png", "image/heic"]).has(input.mimeType)) throw new Error("unsupported capture format");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0 || input.byteLength > 25 * 1024 * 1024) throw new Error("capture size is outside allowed bounds");
  if (input.width < 512 || input.height < 512) throw new Error("capture resolution is too low");
  const warnings = input.width < 1024 || input.height < 1024 ? ["higher resolution is recommended"] : [];
  return { accepted: true, warnings };
}

function validateCommand(value: unknown): asserts value is OfflineCommand {
  if (!value || typeof value !== "object") throw new Error("offline command must be an object");
  const command = value as Partial<OfflineCommand>;
  if (!command.id || !command.idempotencyKey || !command.batchId || !/^B\d{2,3}$/.test(command.batchId) || !command.payload || !command.createdAt || !command.expiresAt) {
    throw new Error("offline command is incomplete");
  }
}
