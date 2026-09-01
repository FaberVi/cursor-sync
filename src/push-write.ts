import * as vscode from "vscode";
import { withRetry } from "./retry.js";
import { saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { clearConflicts } from "./conflicts.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import {
  isChatSyncEnabled,
  storeChatSyncFingerprint,
  computeChatSyncLocalFingerprint,
} from "./chat-sync.js";
import {
  buildSyncStateAfterWrite,
  RepoBackend,
} from "./remote/index.js";
import type { RemoteSnapshot, RemoteSyncBackend } from "./remote/index.js";
import type { SyncProgressReport } from "./sync-progress-events.js";
import type { ApiResult, SyncState } from "./types.js";
import type { PushTrigger } from "./push.js";
import type { PushPackageResult } from "./push-package.js";

export async function writePushRemote(
  context: vscode.ExtensionContext,
  trigger: PushTrigger,
  progress: vscode.Progress<SyncProgressReport> & { percent?: number },
  backend: RemoteSyncBackend,
  syncState: SyncState | undefined,
  remoteChecksums: Record<string, string>,
  keepRemoteKeys: Set<string>,
  snapshotResult: ApiResult<RemoteSnapshot>,
  packaged: PushPackageResult
): Promise<boolean> {
  const logger = getLogger();
  const { delta, chatForDelta, chatBundleCount, manifest } = packaged;

  if (delta.isNoOp) {
    progress.report({ message: "Already in sync" });
    if (syncState) {
      const checksums: Record<string, string> = {
        ...syncState.localChecksums,
      };
      for (const key of keepRemoteKeys) {
        const remoteChecksum = remoteChecksums[key];
        if (remoteChecksum) {
          checksums[key] = remoteChecksum;
        }
      }
      if (chatForDelta) {
        checksums[chatForDelta.syncKey] = chatForDelta.checksum;
      }
      const remoteId =
        (snapshotResult.ok && snapshotResult.data.id) ||
        syncState.gistId ||
        "";
      if (remoteId) {
        const alignedState: SyncState = {
          ...buildSyncStateAfterWrite(
            syncState,
            backend,
            remoteId,
            checksums,
            "push"
          ),
          remoteChecksums: {
            ...syncState.remoteChecksums,
            ...remoteChecksums,
            ...Object.fromEntries(
              [...keepRemoteKeys]
                .filter((key) => remoteChecksums[key])
                .map((key) => [key, remoteChecksums[key]!])
            ),
          },
        };
        await saveSyncState(context, alignedState);
      }
    }
    await clearConflicts();
    if (isChatSyncEnabled()) {
      try {
        const fingerprint = await computeChatSyncLocalFingerprint();
        await storeChatSyncFingerprint(context, fingerprint);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(
          `[${new Date().toISOString()}] Push chat fingerprint skipped: ${msg}`
        );
      }
    }
    logger.appendLine(
      `[${new Date().toISOString()}] Push skipped: already in sync (${delta.unchangedCount} unchanged) → ${backend.remoteLabel()}`
    );
    if (trigger === "manual") {
      vscode.window.showInformationMessage(
        `Already in sync, nothing to push (${delta.unchangedCount} file(s) unchanged).`
      );
    }
    sendEvent(context, "sync_completed", {
      direction: "push",
      file_count: 0,
      trigger,
      skipped_unchanged: delta.unchangedCount,
      destination_type: backend.type,
      noop: true,
    });
    return true;
  }

  const remoteFiles: Record<string, string> = {
    ...delta.filesToUpload,
    "manifest.json": JSON.stringify(manifest, null, 2),
  };

  progress.report({
    message: `Uploading ${delta.uploadedSyncKeys.length} changed file(s)…`,
  });
  const uploadFloor =
    typeof progress.percent === "number" ? progress.percent : 0;
  const writeResult =
    backend instanceof RepoBackend
      ? await backend.writeFiles(remoteFiles, {
          deleteNames: delta.deleteNames,
          onBlobProgress: (completed, total) => {
            const ratio = total > 0 ? completed / total : 1;
            progress.report({
              message: `Uploading ${completed}/${total} changed file(s)…`,
              percent: uploadFloor + ratio * (95 - uploadFloor),
            });
          },
        })
      : await withRetry(() =>
          backend.writeFiles(remoteFiles, { deleteNames: delta.deleteNames })
        );
  if (!writeResult.ok) {
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("push", trigger, writeResult.error.message, {
        direction: "push",
        category: writeResult.error.category,
        statusCode: writeResult.error.statusCode,
      }),
      { title: `Push failed: ${writeResult.error.message}` }
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Push failed: ${writeResult.error.category} - ${writeResult.error.message}`
    );
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "push",
      trigger,
      fileCount: 0,
      success: false,
      error: writeResult.error.message,
      files: delta.uploadedSyncKeys.sort(),
    });
    sendEvent(context, "sync_failed", {
      direction: "push",
      reason: writeResult.error.category,
      trigger,
      status_code: writeResult.error.statusCode,
    });
    return false;
  }

  progress.report({ message: "Saving sync state…" });
  const checksums: Record<string, string> = {};
  for (const [key, value] of packaged.packaged) {
    checksums[key] = value.checksum;
  }
  for (const key of keepRemoteKeys) {
    const remoteChecksum = remoteChecksums[key];
    if (remoteChecksum) {
      checksums[key] = remoteChecksum;
    }
  }
  if (chatForDelta) {
    checksums[chatForDelta.syncKey] = chatForDelta.checksum;
  }

  const historyFiles = [...delta.uploadedSyncKeys, ...keepRemoteKeys].sort();
  const fileCount = historyFiles.length;
  const chatSuffix =
    chatBundleCount > 0 ? ` · ${chatBundleCount} chat(s)` : "";
  const skipSuffix =
    delta.unchangedCount > 0
      ? ` (${delta.unchangedCount} unchanged skipped)`
      : "";
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "push",
    trigger,
    fileCount,
    totalFileCount: Object.keys(manifest.files).length,
    success: true,
    files: historyFiles,
  });

  const newState: SyncState = buildSyncStateAfterWrite(
    syncState,
    backend,
    writeResult.data.id,
    checksums,
    "push"
  );
  await saveSyncState(context, newState);
  await clearConflicts();
  if (isChatSyncEnabled()) {
    try {
      const fingerprint = await computeChatSyncLocalFingerprint();
      await storeChatSyncFingerprint(context, fingerprint);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.appendLine(
        `[${new Date().toISOString()}] Push chat fingerprint skipped: ${msg}`
      );
    }
  }

  sendEvent(context, "sync_completed", {
    direction: "push",
    file_count: fileCount,
    trigger,
    is_new_gist: writeResult.data.created,
    destination_type: backend.type,
    skipped_unchanged: delta.unchangedCount,
  });
  progress.report({ message: "Done" });
  if (trigger === "manual") {
    vscode.window.showInformationMessage(
      `Push complete: ${fileCount} file(s) synced${skipSuffix}${chatSuffix}.`
    );
  }
  logger.appendLine(
    `[${new Date().toISOString()}] Push succeeded: ${fileCount} files uploaded, ${delta.unchangedCount} unchanged → ${backend.remoteLabel()}`
  );
  return true;
}
