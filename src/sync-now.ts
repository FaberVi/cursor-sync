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
import { getPendingConflicts, getUnresolvedConflicts } from "./conflicts.js";
import {
  beginSyncAbort,
  endSyncAbort,
  getSyncAbortSignal,
  isAbortError,
  isSyncAborted,
} from "./sync-abort.js";

export async function executeSyncNow(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Sync Now triggered`);

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
        progress.complete(await executePull(context, { trigger: "syncNow" }));
        break;
      case "push":
        progress.report({ message: "Pushing…" });
        progress.complete(await executePush(context));
        break;
      case "pull-push": {
        progress.report({ message: "Pulling…" });
        const pullOk = await executePull(context, { trigger: "syncNow" });
        if (pullOk && !getSyncAbortSignal()?.aborted) {
          progress.report({ message: "Pushing…" });
          progress.complete(await executePush(context));
        } else {
          progress.complete(false);
        }
        break;
      }
      case "conflict": {
        await vscode.commands.executeCommand("cursorSync.resolveConflicts");
        if (isSyncAborted()) {
          progress.complete(false);
          break;
        }
        const still = getUnresolvedConflicts(getPendingConflicts());
        if (still.length > 0) {
          const conflictMessage = `${still.length} conflict(s) detected. Resolve them first.`;
          void showSyncFailureWithDebug(
            context,
            buildSyncDebugFailure("syncNow", "manual", conflictMessage, {
              category: "CONFLICT",
              conflictCount: still.length,
            }),
            { level: "warning", title: conflictMessage }
          );
        }
        progress.complete(false);
        break;
      }
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
  }
}
