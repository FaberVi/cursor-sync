import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { notifySyncQuiet } from "./sync-notify.js";
import { saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { resolveSyncRoots, gistFileNameToSyncKey, isExcludedSyncKey, enumerateSyncFiles } from "./paths.js";
import { migrateAndLogSkillArtifacts } from "./skill-artifacts-migrate.js";
import { computeChecksum } from "./packaging.js";
import { clearConflicts, getResolutionForKey } from "./conflicts.js";
import { createBackup, pruneOldBackups, ensureParentDirectory } from "./rollback.js";
import {
  commitSyncFileJournal,
  markJournalStateWritten,
  rollbackSyncFileJournal,
  setSyncFileJournal,
  throwIfAborted,
  SyncCancelledError,
} from "./sync-abort.js";
import {
  applyLocalDeletes, planLocalDeletes, syncKeyToAbsolutePath, PartialLocalDeleteError,
} from "./sync-local-deletes.js";
import { sendEvent } from "./analytics.js";
import { buildSyncDebugFailure, showSyncFailureWithDebug } from "./sync-debug.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import { CURSOR_CHAT_GIST_FILE_NAME } from "./chat-sync.js";
import { buildSyncStateAfterWrite, normalizeSyncStateDestination } from "./remote/index.js";
import type { SyncProgressReport } from "./sync-progress-events.js";
import type { SyncState } from "./types.js";
import type { PullTrigger, PullRemoteFetchSuccess } from "./pull-remote-fetch.js";
import { applyRemoteExtensionSync } from "./pull-chat-import.js";

export type PullFileToWrite = { absolutePath: string; syncKey: string; content: Buffer };
export type PullApplyWritten = {
  status: "written"; filesToWrite: PullFileToWrite[]; deletedKeys: string[];
  newState: SyncState; keepLocalExtensions: boolean;
};
export type PullApplyResult = { status: "failed" } | { status: "complete" } | PullApplyWritten;

export async function applyPullFiles(
  context: vscode.ExtensionContext,
  trigger: PullTrigger,
  progress: vscode.Progress<SyncProgressReport> & { percent?: number },
  mirror: boolean,
  fetched: PullRemoteFetchSuccess
): Promise<PullApplyResult> {
  const logger = getLogger();
  const { backend, snapshot, manifest, remoteChecksums, remoteFiles, conflicts, syncState } = fetched;

  const extensionsKey = "cursor-user/extensions.json";
  const keepLocalExtensions =
    getResolutionForKey(extensionsKey) === "keepLocal";

  const roots = resolveSyncRoots();
  const filesToWrite: PullFileToWrite[] = [];

  for (const [gistFileName, fileContent] of Object.entries(remoteFiles)) {
    if (
      gistFileName === "manifest.json" ||
      gistFileName === CHAT_BUNDLES_GIST_FILE_NAME ||
      gistFileName === CURSOR_CHAT_GIST_FILE_NAME
    ) {
      continue;
    }

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) {
      continue;
    }

    if (isExcludedSyncKey(syncKey) || getResolutionForKey(syncKey) === "keepLocal") continue;
    const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
    if (!absolutePath) continue;

    const content =
      manifestEntry.encoding === "base64"
        ? Buffer.from(fileContent, "base64")
        : Buffer.from(fileContent, "utf-8");

    const remoteChecksum = computeChecksum(content);
    const localChecksum = syncState?.localChecksums?.[syncKey];
    if (localChecksum && localChecksum === remoteChecksum) {
      continue;
    }

    filesToWrite.push({ absolutePath, syncKey, content });
  }

  const localEntries = await enumerateSyncFiles(roots);
  const localSyncKeys = localEntries.map((e) => e.relativeSyncKey);
  const keepLocalKeys = new Set<string>();
  for (const key of new Set([...localSyncKeys, ...Object.keys(remoteChecksums)])) {
    if (getResolutionForKey(key) === "keepLocal") {
      keepLocalKeys.add(key);
    }
  }

  const deleteMode = mirror ? "mirror" : "remoteRemoved";
  const keysToDelete = planLocalDeletes({
    mode: deleteMode,
    localSyncKeys,
    remoteChecksums,
    previousRemoteChecksums: syncState?.remoteChecksums ?? {},
    keepLocalKeys,
  });

  const config = vscode.workspace.getConfiguration("cursorSync");
  const safeMode = config.get<boolean>("safeMode") ?? true;

  if (mirror) {
    const n = filesToWrite.length;
    const m = keysToDelete.length;
    if (n === 0 && m === 0) {
      return completePullAlreadyInSync({
        context,
        trigger,
        progress,
        fetched,
        keepLocalExtensions,
        fillChecksums: (localChecksums) => {
          for (const key of keepLocalKeys) {
            const conflict = conflicts.find((c) => c.relativeSyncKey === key);
            if (conflict) {
              localChecksums[key] = conflict.localChecksum;
            }
          }
        },
        toast:
          trigger === "manual" || trigger === "syncNow"
            ? "Pull complete: already in sync."
            : undefined,
      });
    }

    const keepNote =
      keepLocalKeys.size > 0
        ? ` Files marked Keep Local (${keepLocalKeys.size}) will be preserved.`
        : "";
    const choice = await vscode.window.showWarningMessage(
      `Mirror will align this machine to the remote: update ${n} file(s) and delete ${m} file(s) present only locally (settings, skills, rules, …).${keepNote} Continue?`,
      { modal: true },
      "Proceed",
      "Cancel"
    );
    if (choice !== "Proceed") {
      logger.appendLine(`[${new Date().toISOString()}] Mirror pull cancelled by user`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "cancelled", trigger });
      return { status: "failed" };
    }
    throwIfAborted();
  } else if (!mirror && trigger === "manual" && safeMode && filesToWrite.length > 0) {
    const items = filesToWrite.map((f) => ({
      label: f.syncKey,
      picked: true,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Files to overwrite",
      placeHolder: "Deselect files you do not want to overwrite",
    });

    if (!selected) {
      logger.appendLine(`[${new Date().toISOString()}] Pull cancelled by user`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "cancelled", trigger });
      return { status: "failed" };
    }

    throwIfAborted();

    const selectedKeys = new Set(selected.map((s) => s.label));
    const filtered = filesToWrite.filter((f) => selectedKeys.has(f.syncKey));
    filesToWrite.length = 0;
    filesToWrite.push(...filtered);
  }

  if (filesToWrite.length === 0 && keysToDelete.length === 0) {
    return completePullAlreadyInSync({
      context,
      trigger,
      progress,
      fetched,
      keepLocalExtensions,
      fillChecksums: (localChecksums) => {
        for (const conflict of conflicts) {
          if (getResolutionForKey(conflict.relativeSyncKey) === "keepLocal") {
            localChecksums[conflict.relativeSyncKey] = conflict.localChecksum;
          }
        }
      },
      toast: trigger === "manual" ? "Pull complete: no files to update." : undefined,
    });
  }

  const deleteAbsPaths = keysToDelete
    .map((key) => syncKeyToAbsolutePath(key, roots))
    .filter((p): p is string => Boolean(p));

  progress.report({ message: "Creating local backup…" });
  const { entries: backupEntries } = await createBackup(context, [
    ...filesToWrite.map((f) => f.absolutePath),
    ...deleteAbsPaths,
  ]);

  const createdPaths: string[] = [];
  setSyncFileJournal({
    backupEntries,
    createdPaths,
    previousSyncState: syncState,
  });

  const writtenBackups: typeof backupEntries = [];
  let writeError = false;
  let failedSyncKey: string | undefined;
  let failedErrorDetail: string | undefined;

  progress.report({
    message: `Writing ${filesToWrite.length} file(s)…`,
  });
  const writeFloor =
    typeof progress.percent === "number" ? progress.percent : 0;
  let writtenCount = 0;
  for (const file of filesToWrite) {
    throwIfAborted();
    try {
      await ensureParentDirectory(file.absolutePath);
      const tmpPath = file.absolutePath + ".tmp";
      await fs.writeFile(tmpPath, file.content);
      await fs.rename(tmpPath, file.absolutePath);
      writtenCount += 1;
      const writeTotal = filesToWrite.length;
      const writeRatio = writeTotal > 0 ? writtenCount / writeTotal : 1;
      progress.report({
        message: `Writing ${writtenCount}/${writeTotal} file(s)…`,
        percent: writeFloor + writeRatio * (95 - writeFloor),
      });
      const backup = backupEntries.find((b) => b.absolutePath === file.absolutePath);
      if (backup) {
        writtenBackups.push(backup);
      } else {
        createdPaths.push(file.absolutePath);
      }
    } catch (err) {
      if (err instanceof SyncCancelledError) {
        throw err;
      }
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.appendLine(
        `[${new Date().toISOString()}] Write failed for ${file.syncKey} (${file.absolutePath}): ${errMessage}`
      );
      failedSyncKey = file.syncKey;
      failedErrorDetail = errMessage;
      writeError = true;
      break;
    }
  }

  let deletedKeys: string[] = [];
  if (!writeError && keysToDelete.length > 0) {
    throwIfAborted();
    progress.report({ message: `Removing ${keysToDelete.length} local file(s)…` });
    try {
      const applied = await applyLocalDeletes(context, keysToDelete, roots, {
        backupEntries,
      });
      deletedKeys = applied.deletedKeys;
      for (const b of applied.backupEntries) {
        if (!writtenBackups.some((w) => w.absolutePath === b.absolutePath)) {
          writtenBackups.push(b);
        }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof PartialLocalDeleteError) {
        deletedKeys = err.deletedKeys;
        failedSyncKey = err.failedKey;
        for (const b of err.backupEntries) {
          if (!writtenBackups.some((w) => w.absolutePath === b.absolutePath)) {
            writtenBackups.push(b);
          }
        }
      } else {
        failedSyncKey = keysToDelete[0];
      }
      failedErrorDetail = errMessage;
      writeError = true;
    }
  }

  if (writeError) {
    logger.appendLine(`[${new Date().toISOString()}] Rolling back partial writes`);
    await rollbackSyncFileJournal();
    const failureDetail = failedSyncKey
      ? `Could not write/delete ${failedSyncKey}${failedErrorDetail ? ` (${failedErrorDetail})` : ""}.`
      : "file write error.";
    const writeErrorMessage = `Pull failed: ${failureDetail} Changes have been rolled back.`;
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, writeErrorMessage, {
        direction: "pull",
        category: "FILE_SYSTEM_ERROR",
      }),
      { title: writeErrorMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: FILE_SYSTEM_ERROR`);
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: false,
      error: "File write error",
      files: [...filesToWrite.map((f) => f.syncKey), ...keysToDelete].sort(),
    });
    sendEvent(context, "sync_failed", { direction: "pull", reason: "FILE_SYSTEM_ERROR", trigger });
    return { status: "failed" };
  }

  progress.report({ message: "Saving sync state…" });
  await pruneOldBackups(context);

  const newLocalChecksums: Record<string, string> = {
    ...(syncState?.localChecksums || {}),
  };
  for (const file of filesToWrite) {
    newLocalChecksums[file.syncKey] = computeChecksum(file.content);
  }
  for (const key of deletedKeys) {
    delete newLocalChecksums[key];
  }
  for (const conflict of conflicts) {
    if (getResolutionForKey(conflict.relativeSyncKey) === "keepLocal") {
      newLocalChecksums[conflict.relativeSyncKey] = conflict.localChecksum;
    }
  }

  let newState: SyncState = buildSyncStateAfterWrite(
    syncState,
    backend,
    snapshot.id,
    newLocalChecksums,
    "pull"
  );
  newState = normalizeSyncStateDestination({
    ...newState,
    remoteChecksums,
  });
  await saveSyncState(context, newState);
  markJournalStateWritten();

  const historyFiles = [
    ...filesToWrite.map((f) => f.syncKey),
    ...deletedKeys.map((k) => `-${k}`),
  ].sort();
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "pull",
    trigger,
    fileCount: filesToWrite.length + deletedKeys.length,
    totalFileCount: Object.keys(manifest.files).length,
    success: true,
    files: historyFiles,
  });
  await clearConflicts();
  sendEvent(context, "sync_completed", {
    direction: "pull",
    file_count: filesToWrite.length + deletedKeys.length,
    trigger,
    destination_type: backend.type,
  });

  commitSyncFileJournal();
  return { status: "written", filesToWrite, deletedKeys, newState, keepLocalExtensions };
}

async function completePullAlreadyInSync(params: {
  context: vscode.ExtensionContext; trigger: PullTrigger;
  progress: vscode.Progress<SyncProgressReport> & { percent?: number };
  fetched: PullRemoteFetchSuccess; keepLocalExtensions: boolean;
  fillChecksums: (localChecksums: Record<string, string>) => void; toast?: string;
}): Promise<PullApplyResult> {
  const { context, trigger, progress, fetched, keepLocalExtensions, fillChecksums, toast } = params;
  const { backend, snapshot, manifest, remoteChecksums, remoteFiles, syncState } = fetched;
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(), direction: "pull", trigger,
    fileCount: 0, totalFileCount: Object.keys(manifest.files).length, success: true, files: [],
  });
  const localChecksums = { ...(syncState?.localChecksums || {}) };
  fillChecksums(localChecksums);
  let alignedState: SyncState = buildSyncStateAfterWrite(syncState, backend, snapshot.id, localChecksums, "pull");
  alignedState = normalizeSyncStateDestination({ ...alignedState, remoteChecksums });
  await saveSyncState(context, alignedState);
  await clearConflicts();
  sendEvent(context, "sync_completed", { direction: "pull", file_count: 0, trigger });
  await applyRemoteExtensionSync(context, remoteFiles, getLogger(), keepLocalExtensions, progress);
  if (toast) notifySyncQuiet(toast);
  progress.report({ message: "Done" });
  await migrateAndLogSkillArtifacts();
  commitSyncFileJournal();
  return { status: "complete" };
}
