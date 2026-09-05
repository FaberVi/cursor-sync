import * as vscode from "vscode";
import { executePush, isPushLocked } from "./push.js";
import { executePull, isPullLocked } from "./pull.js";
import { requireToken } from "./auth.js";
import { getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { notifySyncQuiet } from "./sync-notify.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import {
  computeChatSyncLocalFingerprint,
  isChatSyncEnabled,
  readStoredChatSyncFingerprint,
  CURSOR_CHAT_SYNC_KEY,
} from "./chat-sync.js";
import { computeChecksum } from "./packaging.js";
import { resolveScheduleInterval } from "./schedule-interval.js";
import { isRepoDestinationConfigured } from "./remote/destination.js";
import { loadSyncState } from "./diagnostics.js";
import {
  ensureSyncClone,
  hasNestedSyncFiles,
  relationToOrigin,
} from "./sync-clone.js";
import {
  hashCloneSyncFiles,
  hashCursorSyncFiles,
  readCloneChatRaw,
  syncKeysDiffer,
} from "./sync-copy.js";
import { decideSyncAction, type SyncAction } from "./sync-action.js";
import { GitNotFoundError } from "./git-cli.js";
import { enterSyncLock, leaveSyncLock } from "./sync-lock.js";
import { beginSyncAbort, endSyncAbort } from "./sync-abort.js";

const MAX_JITTER_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;
let jitterTimeout: ReturnType<typeof setTimeout> | undefined;

export type { SyncAction } from "./sync-action.js";

export function startScheduler(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("cursorSync");
  const resolved = resolveScheduleInterval(config);

  if (!resolved.enabled) {
    return;
  }

  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);

  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] Scheduler starting: interval=${resolved.displayValue}${resolved.unit === "seconds" ? "s" : "min"} (${resolved.intervalSeconds}s), jitter=${jitter}ms`
  );

  jitterTimeout = setTimeout(() => {
    scheduledTick(context);
    timer = setInterval(() => scheduledTick(context), resolved.intervalMs);
  }, jitter);
}

export function stopScheduler(): void {
  if (jitterTimeout) {
    clearTimeout(jitterTimeout);
    jitterTimeout = undefined;
  }
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export async function determineSyncAction(
  context: vscode.ExtensionContext
): Promise<SyncAction> {
  const syncState = await loadSyncState(context);
  if (!isRepoDestinationConfigured()) {
    return { action: "error", reason: "not_configured" };
  }

  const token = await requireToken(context);
  if (!token) {
    return { action: "error", reason: "no_token" };
  }

  try {
    const clone = await ensureSyncClone(context, token);
    const relation = clone.empty
      ? "empty"
      : await relationToOrigin(clone.clonePath, clone.identity.branch);

    const localHashes = await hashCursorSyncFiles();
    const cloneHashes = await hashCloneSyncFiles(clone.clonePath, clone.identity.basePath);
    let cursorDiffers = syncKeysDiffer(localHashes, cloneHashes);

    if (isChatSyncEnabled()) {
      const fingerprint = await computeChatSyncLocalFingerprint();
      const stored = await readStoredChatSyncFingerprint(context);
      const cloneChat = await readCloneChatRaw(clone.clonePath, clone.identity.basePath);
      const cloneChatChecksum = cloneChat
        ? computeChecksum(Buffer.from(cloneChat, "utf8"))
        : undefined;
      const lastChat = syncState?.localChecksums[CURSOR_CHAT_SYNC_KEY];
      if (stored !== fingerprint || lastChat !== cloneChatChecksum) {
        cursorDiffers = true;
      }
    }

    const nested = await hasNestedSyncFiles(clone.clonePath, clone.identity.basePath);
    return decideSyncAction({
      relation,
      cursorDiffers,
      completedFileSync: syncState?.completedFileSync === true,
      hasNestedRemoteFiles: nested,
    });
  } catch (err) {
    if (err instanceof GitNotFoundError) {
      return { action: "error", reason: err.message };
    }
    return {
      action: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export const scheduledSyncActionResolver = {
  determineSyncAction,
};

export async function scheduledTick(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const resolved = resolveScheduleInterval(config);

  if (!resolved.enabled) {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync skipped: schedule.enabled is false`
    );
    sendEvent(context, "scheduled_sync_skipped", { reason: "disabled" });
    stopScheduler();
    return;
  }

  if (isPushLocked() || isPullLocked()) {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync skipped: operation in progress`
    );
    sendEvent(context, "scheduled_sync_skipped", { reason: "in_progress" });
    return;
  }

  const lockHold = enterSyncLock();
  if (lockHold === "busy") {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync skipped: operation in progress`
    );
    sendEvent(context, "scheduled_sync_skipped", { reason: "in_progress" });
    return;
  }

  logger.appendLine(`[${new Date().toISOString()}] Scheduled sync triggered`);

  beginSyncAbort();
  try {
    const result = await scheduledSyncActionResolver.determineSyncAction(context);

    switch (result.action) {
      case "none":
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: already in sync, skipping`
        );
        sendEvent(context, "scheduled_sync_skipped", { reason: "already_in_sync" });
        break;

      case "pull": {
        const message = "Pull required (will overwrite local Cursor files). Run Pull Now to confirm.";
        logger.appendLine(`[${new Date().toISOString()}] Scheduled sync skipped: ${message}`);
        sendEvent(context, "scheduled_sync_skipped", { reason: "pull_required" });
        await addSyncHistoryEntry(context, {
          timestamp: new Date().toISOString(),
          direction: "pull",
          trigger: "scheduled",
          fileCount: 0,
          success: false,
          error: "pull required",
        });
        notifySyncQuiet(message);
        break;
      }

      case "push": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: local changes detected, pushing`
        );
        await executePush(context, { trigger: "scheduled", skipLock: true });
        break;
      }

      case "error": {
        if (result.reason === "not_configured") {
          logger.appendLine(
            `[${new Date().toISOString()}] Scheduled sync skipped: repository not configured`
          );
          sendEvent(context, "scheduled_sync_skipped", { reason: "not_configured" });
          break;
        }
        const errorMessage = `Scheduled sync failed: ${result.reason}`;
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync skipped: ${result.reason}`
        );
        sendEvent(context, "scheduled_sync_skipped", { reason: result.reason });
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("scheduler", "scheduled", result.reason, {
            category: result.reason,
          }),
          { title: errorMessage }
        );
        break;
      }
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync failed: ${errMessage}`
    );
    sendEvent(context, "scheduled_sync_failed", { reason: "exception" });
    const errorMessage = `Scheduled sync failed: ${errMessage}`;
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("scheduler", "scheduled", errMessage),
      { title: errorMessage }
    );
  } finally {
    endSyncAbort();
    leaveSyncLock(lockHold);
  }
}
