import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { MobileApiClient } from "./api-client";
import { runtimeConfig } from "./runtime";
import { OidcSessionManager } from "./session";
import { NativeUploadService } from "./upload";

export const RESUMABLE_UPLOAD_TASK = "ltm-mobile-resumable-upload-v1";

TaskManager.defineTask(RESUMABLE_UPLOAD_TASK, async () => {
  try {
    const config = runtimeConfig();
    const session = new OidcSessionManager(config);
    const principal = await session.restore();
    if (principal === null) return BackgroundTask.BackgroundTaskResult.Success;
    const service = new NativeUploadService(new MobileApiClient(config, session));
    for (const uploadId of await service.state.listIds()) {
      const state = await service.state.load(uploadId);
      if (state === null) continue;
      if (state.tenantId !== principal.tenantId || state.actorId !== principal.actorId) {
        await service.coordinator.cancel(uploadId);
        continue;
      }
      await service.resume(uploadId, { tenantId: state.tenantId, actorId: state.actorId, purpose: state.purpose }, true, true);
    }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerUploadRecovery(): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(RESUMABLE_UPLOAD_TASK);
  if (!registered) await BackgroundTask.registerTaskAsync(RESUMABLE_UPLOAD_TASK, { minimumInterval: 15 });
}
