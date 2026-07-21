import * as vscode from "vscode";
import { executePush, isPushLocked } from "./push.js";
import { executePull, isPullLocked } from "./pull.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, getLogger } from "./diagnostics.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import {
  CHAT_BUNDLES_SYNC_KEY,
  CURSOR_CHAT_SYNC_KEY,
  isChatSyncEnabled,
  computeChatSyncLocalFingerprint,
  readStoredChatSyncFingerprint,
} from "./chat-sync.js";
import {
  computeLocalChecksums,
  findConflicts,
  registerPendingConflicts,
} from "./conflicts.js";
import { resolveScheduleInterval } from "./schedule-interval.js";
import { createRemoteBackend } from "./remote/factory.js";
import { hasRemoteDestination } from "./remote/destination.js";
import type { Manifest } from "./types.js";

const MAX_JITTER_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;
let jitterTimeout: ReturnType<typeof setTimeout> | undefined;

export type SyncAction =
  | { action: "none" }
  | { action: "pull" }
  | { action: "push" }
  | { action: "pull-push" }
  | { action: "conflict"; keys: string[] }
  | { action: "error"; reason: string };

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
  let syncState = await loadSyncState(context);

  if (!syncState || !hasRemoteDestination(syncState)) {
    return { action: "push" };
  }

  const token = await requireToken(context);
  if (!token) {
    return { action: "error", reason: "no_token" };
  }

  const backend = createRemoteBackend(context, token, syncState);
  if (!backend) {
    return { action: "error", reason: "no_destination" };
  }

  const snapshotResult = await withRetry(() =>
    backend.getSnapshot({ onlyFiles: ["manifest.json"] })
  );
  if (!snapshotResult.ok) {
    return { action: "error", reason: snapshotResult.error.category };
  }

  const manifestContent = snapshotResult.data.files["manifest.json"];
  if (!manifestContent) {
    return { action: "push" };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestContent) as Manifest;
  } catch {
    return { action: "push" };
  }

  const remoteChecksums: Record<string, string> = {};
  for (const [key, entry] of Object.entries(manifest.files)) {
    remoteChecksums[key] = entry.checksum;
  }

  const localChecksums = await computeLocalChecksums();
  if (isChatSyncEnabled()) {
    delete localChecksums[CHAT_BUNDLES_SYNC_KEY];
    const fingerprint = await computeChatSyncLocalFingerprint();
    const stored = await readStoredChatSyncFingerprint(context);
    const lastChatChecksum = syncState.localChecksums[CURSOR_CHAT_SYNC_KEY];
    // Fingerprint is discovery metadata; sync state stores content checksum.
    // When fingerprint matches the last push, treat chat as unchanged.
    if (stored && fingerprint === stored && lastChatChecksum) {
      localChecksums[CURSOR_CHAT_SYNC_KEY] = lastChatChecksum;
    } else {
      localChecksums[CURSOR_CHAT_SYNC_KEY] = fingerprint;
    }
  }

  const conflicts = findConflicts(syncState, localChecksums, remoteChecksums);
  if (conflicts.length > 0) {
    await registerPendingConflicts(conflicts);
    return {
      action: "conflict",
      keys: conflicts.map((c) => c.relativeSyncKey),
    };
  }

  const allKeys = new Set([
    ...Object.keys(localChecksums),
    ...Object.keys(remoteChecksums),
    ...Object.keys(syncState.localChecksums),
    ...Object.keys(syncState.remoteChecksums),
  ]);

  let localHasChanges = false;
  let remoteHasChanges = false;

  for (const key of allKeys) {
    const baseLocal = syncState.localChecksums[key];
    const baseRemote = syncState.remoteChecksums[key];
    const currentLocal = localChecksums[key];
    const currentRemote = remoteChecksums[key];

    if (currentLocal !== baseLocal) {
      localHasChanges = true;
    }
    if (currentRemote !== baseRemote) {
      remoteHasChanges = true;
    }
  }

  if (remoteHasChanges && localHasChanges) {
    return { action: "pull-push" };
  }

  if (remoteHasChanges) {
    return { action: "pull" };
  }

  if (localHasChanges) {
    return { action: "push" };
  }

  return { action: "none" };
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

  // Never run scheduled push/pull unless periodic auto-sync is enabled.
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

  logger.appendLine(
    `[${new Date().toISOString()}] Scheduled sync triggered`
  );

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
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: remote changes detected, pulling`
        );
        await executePull(context, { trigger: "scheduled" });
        break;
      }

      case "push": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: local changes detected, pushing`
        );
        await executePush(context, { trigger: "scheduled" });
        break;
      }

      case "pull-push": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: local and remote changes detected, pulling then pushing`
        );
        const pullOk = await executePull(context, { trigger: "scheduled" });
        if (!pullOk) {
          break;
        }
        await executePush(context, { trigger: "scheduled" });
        break;
      }

      case "conflict": {
        const conflictMessage = `${result.keys.length} conflict(s) detected. Resolve them first.`;
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync skipped: conflicts on [${result.keys.join(", ")}]`
        );
        sendEvent(context, "scheduled_sync_skipped", {
          reason: "conflict",
          conflict_count: result.keys.length,
        });
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("scheduler", "scheduled", conflictMessage, {
            category: "CONFLICT",
            conflictCount: result.keys.length,
          }),
          { level: "warning", title: conflictMessage }
        );
        break;
      }

      case "error": {
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
  }
}
