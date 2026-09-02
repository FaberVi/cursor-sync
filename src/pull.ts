import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { updateStatusBar, restoreStatusBarAfterCancel } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { createSidebarSyncProgress } from "./sync-progress-events.js";
import type { SyncProgressReport } from "./sync-progress-events.js";
import { formatElapsedPrecise } from "./elapsed.js";
import { fetchPullRemote, type PullTrigger } from "./pull-remote-fetch.js";
import { applyPullFiles } from "./pull-apply-files.js";
import { finishPullChatImport } from "./pull-chat-import.js";
import {
  beginSyncAbort,
  endSyncAbort,
  finishCancelledOperation,
  isAbortError,
  isSyncAborted,
} from "./sync-abort.js";

export type { PullTrigger } from "./pull-remote-fetch.js";

export type PullOptions = {
  trigger?: PullTrigger;
  /** Full mirror: delete all local-only sync files (Pull command only). */
  mirror?: boolean;
};

let pullLock = false;

export function isPullLocked(): boolean {
  return pullLock;
}

export async function executePull(
  context: vscode.ExtensionContext,
  options?: PullOptions
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";
  const mirror = options?.mirror === true;

  if (pullLock) {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

  pullLock = true;
  updateStatusBar("syncing");
  beginSyncAbort();
  const progress = createSidebarSyncProgress("pull");
  const startedAt = Date.now();
  try {
    progress.report({ message: mirror ? "Starting mirror pull…" : "Starting pull…" });
    const success = await doPull(context, trigger, progress, mirror);
    if (!success && isSyncAborted()) {
      await finishCancelledOperation(context, "pull", trigger);
      progress.complete(false);
      restoreStatusBarAfterCancel();
      refreshSidebar();
      return false;
    }
    progress.complete(success);
    getLogger().appendLine(
      `[${new Date().toISOString()}] Pull finished in ${formatElapsedPrecise(Date.now() - startedAt)} (${success ? "ok" : "failed"}).`
    );
    updateStatusBar(success ? "ok" : "error", new Date());
    refreshSidebar();
    return success;
  } catch (err) {
    progress.complete(false);
    getLogger().appendLine(
      `[${new Date().toISOString()}] Pull finished in ${formatElapsedPrecise(Date.now() - startedAt)} (failed).`
    );
    if (isAbortError(err) || isSyncAborted()) {
      await finishCancelledOperation(context, "pull", trigger);
      restoreStatusBarAfterCancel();
      refreshSidebar();
      return false;
    }
    updateStatusBar("error", new Date());
    refreshSidebar();
    throw err;
  } finally {
    pullLock = false;
    endSyncAbort();
  }
}

async function doPull(
  context: vscode.ExtensionContext,
  trigger: PullTrigger = "manual",
  progress: vscode.Progress<SyncProgressReport> & { percent?: number } = {
    report: () => {},
  },
  mirror = false
): Promise<boolean> {
  const fetched = await fetchPullRemote(context, trigger, progress, mirror);
  if (!fetched.ok) {
    return false;
  }
  const applied = await applyPullFiles(context, trigger, progress, mirror, fetched);
  if (applied.status === "failed") {
    return false;
  }
  if (applied.status === "complete") {
    return true;
  }
  return finishPullChatImport(context, trigger, progress, fetched, applied);
}
