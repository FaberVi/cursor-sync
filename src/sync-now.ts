import * as vscode from "vscode";
import { executePush, stageDeletionsAndRebase } from "./push.js";
import { executePull } from "./pull.js";
import { pushClone } from "./sync-clone.js";
import { gitResetHard } from "./git-cli.js";
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
import { leaveSyncLock } from "./sync-lock.js";
import { acquireSyncOperationLock } from "./sync-lock-acquire.js";

export async function executeSyncNow(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Sync Now triggered`);

  let lockHold = await acquireSyncOperationLock(context, { forceRecover: true });
  if (lockHold === "busy") {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    const { executeRefreshSyncStatus } = await import("./refresh-sync-status.js");
    await executeRefreshSyncStatus(context);
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
      case "pull": {
        const staged = await stageDeletionsAndRebase(context, progress);
        if (staged.status === "failed") {
          progress.complete(false);
          break;
        }
        progress.report({ message: "Pulling…" });
        const pulled = await executePull(context, {
          trigger: "syncNow",
          skipLock: true,
        });
        if (!pulled) {
          if (staged.status === "staged") {
            await gitResetHard(staged.clonePath, staged.preSha);
          }
          progress.complete(false);
          break;
        }
        if (staged.status === "staged") {
          progress.report({ message: "Pushing local deletions…" });
          await pushClone({
            clonePath: staged.clonePath,
            branch: staged.branch,
            pat: staged.token,
            setUpstream: false,
          });
          progress.complete(true);
          break;
        }
        const followUp = await determineSyncAction(context);
        if (followUp.action === "push") {
          progress.report({ message: "Pushing…" });
          progress.complete(
            await executePush(context, { skipLock: true, trigger: "syncNow" })
          );
          break;
        }
        if (followUp.action === "error") {
          const errorMessage = `Sync failed: ${followUp.reason}`;
          void showSyncFailureWithDebug(
            context,
            buildSyncDebugFailure("syncNow", "manual", followUp.reason, {
              category: followUp.reason,
            }),
            { title: errorMessage }
          );
          progress.complete(false);
          break;
        }
        progress.complete(true);
        break;
      }
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
