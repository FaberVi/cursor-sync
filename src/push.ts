import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncKeyToGistFileName, resolveSyncRoots } from "./paths.js";
import { requireToken, validateStoredToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { notifySyncQuiet } from "./sync-notify.js";
import {
  detectConflicts,
  gateUnresolvedConflicts,
  getResolutionForKey,
} from "./conflicts.js";
import { updateStatusBar, restoreStatusBarAfterCancel } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import {
  createRemoteBackend,
  readDestinationSettings,
  remoteSnapshotFileNames,
  RepoBackend,
} from "./remote/index.js";
import { ensureRepoExistsInteractive } from "./remote/ensure-repo.js";
import { createSidebarSyncProgress } from "./sync-progress-events.js";
import type { SyncProgressReport } from "./sync-progress-events.js";
import { formatElapsedPrecise } from "./elapsed.js";
import { ensureParentDirectory } from "./rollback.js";
import type { ManifestFileEntry } from "./types.js";
import { packagePushFiles } from "./push-package.js";
import { writePushRemote } from "./push-write.js";
import {
  beginSyncAbort,
  commitSyncFileJournal,
  endSyncAbort,
  finishCancelledOperation,
  isAbortError,
  isSyncAborted,
  throwIfAborted,
} from "./sync-abort.js";

export type PushTrigger = "manual" | "scheduled";

let pushLock = false;

export function isPushLocked(): boolean {
  return pushLock;
}

export async function executePush(
  context: vscode.ExtensionContext,
  options?: { trigger?: PushTrigger }
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";

  if (pushLock) {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

  pushLock = true;
  updateStatusBar("syncing");
  beginSyncAbort();
  const progress = createSidebarSyncProgress("push");
  const startedAt = Date.now();
  try {
    progress.report({ message: "Starting push…" });
    const success = await doPush(context, trigger, progress);
    if (!success && isSyncAborted()) {
      await finishCancelledOperation(context, "push", trigger);
      progress.complete(false);
      restoreStatusBarAfterCancel();
      refreshSidebar();
      return false;
    }
    if (success) {
      commitSyncFileJournal();
    }
    progress.complete(success);
    getLogger().appendLine(
      `[${new Date().toISOString()}] Push finished in ${formatElapsedPrecise(Date.now() - startedAt)} (${success ? "ok" : "failed"}).`
    );
    updateStatusBar(success ? "ok" : "error", new Date());
    refreshSidebar();
    return success;
  } catch (err) {
    progress.complete(false);
    getLogger().appendLine(
      `[${new Date().toISOString()}] Push finished in ${formatElapsedPrecise(Date.now() - startedAt)} (failed).`
    );
    if (isAbortError(err) || isSyncAborted()) {
      await finishCancelledOperation(context, "push", trigger);
      restoreStatusBarAfterCancel();
      refreshSidebar();
      return false;
    }
    updateStatusBar("error", new Date());
    refreshSidebar();
    const errMessage = err instanceof Error ? err.message : String(err);
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("push", trigger, errMessage, {
        direction: "push",
      }),
      { title: `Push failed: ${errMessage}` }
    );
    return false;
  } finally {
    pushLock = false;
    endSyncAbort();
  }
}

async function doPush(
  context: vscode.ExtensionContext,
  trigger: PushTrigger = "manual",
  progress: vscode.Progress<SyncProgressReport> & { percent?: number } = {
    report: () => {},
  }
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Push started`);

  const authFailedMessage =
    "GitHub token not configured. Configure your token to sync.";

  progress.report({ message: "Checking GitHub token…" });
  if (!(await validateStoredToken(context))) {
    const token = await requireToken(context);
    if (!token) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("push", trigger, authFailedMessage, {
          direction: "push",
          category: "AUTH_FAILED",
        }),
        { title: authFailedMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Push failed: AUTH_FAILED`);
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: 0,
        success: false,
        error: authFailedMessage,
      });
      sendEvent(context, "sync_failed", { direction: "push", reason: "AUTH_FAILED", trigger });
      return false;
    }
  }

  const token = await requireToken(context);
  if (!token) {
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("push", trigger, authFailedMessage, {
        direction: "push",
        category: "AUTH_FAILED",
      }),
      { title: authFailedMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Push failed: AUTH_FAILED`);
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "push",
      trigger,
      fileCount: 0,
      success: false,
      error: authFailedMessage,
    });
    sendEvent(context, "sync_failed", { direction: "push", reason: "AUTH_FAILED", trigger });
    return false;
  }

  const syncState = await loadSyncState(context);
  const destSettings = readDestinationSettings();
  if (destSettings.type === "repo" && !destSettings.repo) {
    const message =
      "Repository destination selected but cursorSync.destination.repo is empty (owner/name).";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("push", trigger, message, {
        direction: "push",
        category: "not_configured",
      }),
      { title: message }
    );
    return false;
  }

  progress.report({
    message:
      destSettings.type === "repo"
        ? "Connecting to GitHub repository…"
        : "Connecting to GitHub Gist…",
  });
  const backend = createRemoteBackend(context, token, syncState);
  if (!backend) {
    const message =
      "Could not create remote sync backend. Check destination settings.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("push", trigger, message, {
        direction: "push",
        category: "not_configured",
      }),
      { title: message }
    );
    return false;
  }

  if (backend instanceof RepoBackend && trigger === "manual") {
    progress.report({ message: "Verifying repository…" });
    const ensured = await ensureRepoExistsInteractive(backend);
    if (!ensured.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("push", trigger, ensured.error.message, {
          direction: "push",
          category: ensured.error.category,
          statusCode: ensured.error.statusCode,
        }),
        { title: `Push failed: ${ensured.error.message}` }
      );
      return false;
    }
  }

  progress.report({ message: "Fetching remote manifest…" });
  const remoteStarted = Date.now();
  const snapshotResult = await withRetry(() =>
    backend.getSnapshot({ onlyFiles: ["manifest.json"] })
  );
  let remoteChecksums: Record<string, string> = syncState?.remoteChecksums
    ? { ...syncState.remoteChecksums }
    : {};
  let remoteManifestFiles: Record<string, ManifestFileEntry> = {};
  let existingRemoteNames: string[] = [];
  if (
    !snapshotResult.ok &&
    (snapshotResult.error.category === "CANCELLED" || isSyncAborted())
  ) {
    return false;
  }
  let forceFullUpload = !snapshotResult.ok;

  if (snapshotResult.ok) {
    existingRemoteNames = remoteSnapshotFileNames(snapshotResult.data);
    forceFullUpload =
      existingRemoteNames.length === 0 ||
      snapshotResult.data.files["manifest.json"] === undefined;
    const manifestContent = snapshotResult.data.files["manifest.json"];
    if (manifestContent) {
      try {
        const remoteManifest = JSON.parse(manifestContent) as {
          files: Record<string, ManifestFileEntry>;
        };
        remoteChecksums = {};
        remoteManifestFiles = remoteManifest.files ?? {};
        for (const [key, entry] of Object.entries(remoteManifestFiles)) {
          remoteChecksums[key] = entry.checksum;
        }
      } catch {
        // Fall back to last-known remote checksums / full upload.
        forceFullUpload = true;
      }
    }
  }

  logger.appendLine(
    `[Cursor Sync] Remote manifest ready in ${formatElapsedPrecise(Date.now() - remoteStarted)}.`
  );
  throwIfAborted();

  let keepRemoteKeys = new Set<string>();
  if (syncState) {
    progress.report({ message: "Checking for conflicts…" });
    const conflicts = await detectConflicts(context, remoteChecksums);
    if (conflicts.length > 0) {
      const { unresolved, prompted } = await gateUnresolvedConflicts(trigger, conflicts);
      throwIfAborted();
      if (unresolved.length > 0) {
        const conflictMessage = `${unresolved.length} conflict(s) detected. Resolve them before pushing.`;
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("push", trigger, conflictMessage, {
            direction: "push",
            category: "CONFLICT",
            conflictCount: unresolved.length,
          }),
          { level: "warning", title: conflictMessage }
        );
        logger.appendLine(`[${new Date().toISOString()}] Push blocked: CONFLICT`);
        await addSyncHistoryEntry(context, {
          timestamp: new Date().toISOString(),
          direction: "push",
          trigger,
          fileCount: 0,
          success: false,
          error: "Unresolved conflicts",
          files: unresolved.map((c) => c.relativeSyncKey).sort(),
        });
        sendEvent(context, "sync_failed", { direction: "push", reason: "CONFLICT", trigger });
        return false;
      }
      if (prompted) {
        await addSyncHistoryEntry(context, {
          timestamp: new Date().toISOString(),
          direction: "push",
          trigger,
          fileCount: 0,
          success: true,
          error: "Conflicts resolved; run Sync Now to push",
          files: conflicts.map((c) => c.relativeSyncKey).sort(),
        });
        notifySyncQuiet("Conflicts resolved. Run Sync Now to push.");
        return false;
      }
      for (const conflict of conflicts) {
        if (getResolutionForKey(conflict.relativeSyncKey) === "keepRemote") {
          keepRemoteKeys.add(conflict.relativeSyncKey);
        }
      }
    }
  }

  if (keepRemoteKeys.size > 0) {
    progress.report({ message: "Applying keep-remote resolutions…" });
    const onlyFiles = [...keepRemoteKeys].map(syncKeyToGistFileName);
    const keepSnap = await withRetry(() =>
      backend.getSnapshot({ onlyFiles })
    );
    if (keepSnap.ok) {
      const roots = resolveSyncRoots();
      for (const key of keepRemoteKeys) {
        const remoteName = syncKeyToGistFileName(key);
        const remoteContent = keepSnap.data.files[remoteName];
        if (remoteContent === undefined) {
          logger.appendLine(
            `[${new Date().toISOString()}] keepRemote skipped (missing remotely): ${key}`
          );
          continue;
        }
        const absolutePath = syncKeyToAbsolutePath(key, roots);
        if (!absolutePath) {
          continue;
        }
        const entry = remoteManifestFiles[key];
        const buf =
          entry?.encoding === "base64"
            ? Buffer.from(remoteContent, "base64")
            : Buffer.from(remoteContent, "utf-8");
        await ensureParentDirectory(absolutePath);
        const tmpPath = absolutePath + ".tmp";
        await fs.writeFile(tmpPath, buf);
        await fs.rename(tmpPath, absolutePath);
      }
    } else {
      logger.appendLine(
        `[${new Date().toISOString()}] keepRemote fetch failed: ${keepSnap.error.message}`
      );
    }
  }

  const packaged = await packagePushFiles(
    context,
    progress,
    backend,
    syncState,
    remoteChecksums,
    remoteManifestFiles,
    existingRemoteNames,
    forceFullUpload,
    keepRemoteKeys
  );

  return writePushRemote(
    context,
    trigger,
    progress,
    backend,
    syncState,
    remoteChecksums,
    keepRemoteKeys,
    snapshotResult,
    packaged
  );
}

function syncKeyToAbsolutePath(
  syncKey: string,
  roots: { cursorUser: string; dotCursor: string }
): string | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    const rel = syncKey.slice("cursor-user/".length);
    return path.join(roots.cursorUser, ...rel.split("/"));
  }
  if (syncKey.startsWith("dot-cursor/")) {
    const rel = syncKey.slice("dot-cursor/".length);
    return path.join(roots.dotCursor, ...rel.split("/"));
  }
  return undefined;
}
