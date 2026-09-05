import * as vscode from "vscode";
import { executePush } from "./push.js";
import { executePull } from "./pull.js";
import { determineSyncAction } from "./scheduler.js";
import { getLogger } from "./diagnostics.js";
import { notifySyncQuiet } from "./sync-notify.js";
import {
  promptAndInstallMissingExtensions,
  readLastRemoteExtensions,
} from "./extensions.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import { createSidebarSyncProgress } from "./sync-progress-events.js";
import {
  beginSyncAbort,
  endSyncAbort,
  getSyncAbortSignal,
  isAbortError,
} from "./sync-abort.js";
import { enterSyncLock, leaveSyncLock } from "./sync-lock.js";

export async function executeSyncNow(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Sync Now triggered`);

  const lockHold = enterSyncLock();
  if (lockHold === "busy") {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return;
  }

  const progress = createSidebarSyncProgress("syncNow");
  beginSyncAbort();
  try {
    progress.report({ message: "Determining sync action…" });
    const result = await determineSyncAction(context);
    switch (result.action) {
      case "none":
        progress.report({ message: "Checking extensions…" });
        await promptAndInstallMissingExtensions(
          readLastRemoteExtensions(context),
          logger
        );
        notifySyncQuiet("Already in sync, nothing to do.");
        progress.complete(true);
        break;
      case "pull":
        progress.report({ message: "Pulling…" });
        progress.complete(await executePull(context, { trigger: "syncNow", skipLock: true }));
        break;
      case "push":
        progress.report({ message: "Pushing…" });
        progress.complete(await executePush(context, { skipLock: true, trigger: "syncNow" }));
        break;
      case "error": {
        const errorMessage = `Sync failed: ${result.reason}`;
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("syncNow", "manual", result.reason, {
            category: result.reason,
          }),
          { title: errorMessage }
        );
        progress.complete(false);
        break;
      }
      default:
        progress.complete(false);
        break;
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Sync Now failed: ${errMessage}`
    );
    if (!isAbortError(err) && !getSyncAbortSignal()?.aborted) {
      const errorMessage = `Sync failed: ${errMessage}`;
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("syncNow", "manual", errMessage),
        { title: errorMessage }
      );
    }
    progress.complete(false);
  } finally {
    endSyncAbort();
    leaveSyncLock(lockHold);
  }
}
