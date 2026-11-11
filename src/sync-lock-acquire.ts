import type * as vscode from "vscode";
import { getSyncAbortSignal } from "./sync-abort.js";
import {
  enterSyncLock,
  recoverStaleSyncLockOnly,
  resetSyncLock,
  type SyncLockHold,
} from "./sync-lock.js";

export type SyncLockEntry = SyncLockHold | "busy";

async function refreshAfterLockRecovery(context: vscode.ExtensionContext): Promise<void> {
  const { executeRefreshSyncStatus } = await import("./refresh-sync-status.js");
  await executeRefreshSyncStatus(context);
}

/**
 * Acquire the shared sync lock, recovering a stale latch (or forcing release when requested).
 */
export async function acquireSyncOperationLock(
  context: vscode.ExtensionContext,
  options?: { skipLock?: boolean; forceRecover?: boolean }
): Promise<SyncLockEntry> {
  let hold = enterSyncLock({ skipLock: options?.skipLock });
  if (hold !== "busy") {
    return hold;
  }

  if (getSyncAbortSignal()) {
    return "busy";
  }

  if (options?.forceRecover) {
    resetSyncLock();
    await refreshAfterLockRecovery(context);
  } else if (recoverStaleSyncLockOnly()) {
    await refreshAfterLockRecovery(context);
  } else {
    return "busy";
  }

  hold = enterSyncLock({ skipLock: options?.skipLock });
  return hold;
}
