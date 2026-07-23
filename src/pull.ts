import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { resolveSyncRoots, gistFileNameToSyncKey, isExcludedSyncKey, enumerateSyncFiles } from "./paths.js";
import { migrateAndLogSkillArtifacts } from "./skill-artifacts-migrate.js";
import { computeChecksum } from "./packaging.js";
import { detectConflicts, clearConflicts, getResolutionForKey, getUnresolvedConflicts } from "./conflicts.js";
import { createBackup, rollbackFromBackup, pruneOldBackups, ensureParentDirectory } from "./rollback.js";
import {
  applyLocalDeletes,
  planLocalDeletes,
  syncKeyToAbsolutePath,
  PartialLocalDeleteError,
} from "./sync-local-deletes.js";
import { findMissingExtensions, findExtraExtensions, ensureExtensionsJsonOnDisk } from "./extensions.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import { TRANSCRIPT_MANIFEST_FILE_NAME } from "./transcript-bundle.js";
import {
  CHAT_BUNDLES_SYNC_KEY,
  CURSOR_CHAT_GIST_FILE_NAME,
  CURSOR_CHAT_SYNC_KEY,
  isChatSyncEnabled,
  pullChatCollectionFromRemoteFiles,
  storeChatSyncFingerprint,
  computeChatSyncLocalFingerprint,
} from "./chat-sync.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import {
  buildSyncStateAfterWrite,
  createRemoteBackend,
  hasRemoteDestination,
  normalizeSyncStateDestination,
  readDestinationSettings,
} from "./remote/index.js";
import { createSidebarSyncProgress } from "./sync-progress-events.js";
import type { SyncState, Manifest } from "./types.js";

export type PullTrigger = "manual" | "scheduled" | "syncNow";

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
  const progress = createSidebarSyncProgress("pull");
  try {
    progress.report({ message: mirror ? "Starting mirror pull…" : "Starting pull…" });
    const success = await doPull(context, trigger, progress, mirror);
    progress.complete(success);
    updateStatusBar(success ? "ok" : "error", new Date());
    refreshSidebar();
    return success;
  } catch (err) {
    progress.complete(false);
    updateStatusBar("error", new Date());
    refreshSidebar();
    throw err;
  } finally {
    pullLock = false;
  }
}

async function doPull(
  context: vscode.ExtensionContext,
  trigger: PullTrigger = "manual",
  progress: vscode.Progress<{ message?: string; increment?: number }> = {
    report: () => {},
  },
  mirror = false
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] Pull started (trigger=${trigger}, mirror=${mirror})`
  );

  let syncState = await loadSyncState(context);
  const destSettings = readDestinationSettings();

  progress.report({ message: "Checking GitHub token…" });
  const token = await requireToken(context);
  if (!token) {
    const authFailedMessage =
      "GitHub token not configured. Configure your token to sync.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, authFailedMessage, {
        direction: "pull",
        category: "AUTH_FAILED",
      }),
      { title: authFailedMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: AUTH_FAILED`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
    return false;
  }

  if (destSettings.type === "repo" && !destSettings.repo) {
    const message =
      "Repository destination selected but cursorSync.destination.repo is empty (owner/name).";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, message, {
        direction: "pull",
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
  let backend = createRemoteBackend(context, token, syncState);
  if (!backend) {
    const message =
      "Could not create remote sync backend. Check destination settings.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, message, {
        direction: "pull",
        category: "not_configured",
      }),
      { title: message }
    );
    return false;
  }

  if (!hasRemoteDestination(syncState ?? undefined)) {
    progress.report({ message: "Discovering remote…" });
    const discovered = await withRetry(() => backend!.discover());
    if (!discovered.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, discovered.error.message, {
          direction: "pull",
          category: discovered.error.category,
          statusCode: discovered.error.statusCode,
        }),
        { title: `Pull failed: ${discovered.error.message}` }
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Pull failed: ${discovered.error.category} - ${discovered.error.message}`
      );
      sendEvent(context, "sync_failed", {
        direction: "pull",
        reason: discovered.error.category,
        status_code: discovered.error.statusCode,
        trigger,
      });
      return false;
    }

    if (discovered.data) {
      syncState = buildSyncStateAfterWrite(
        syncState,
        backend,
        discovered.data.id,
        syncState?.localChecksums || {},
        "pull"
      );
      syncState.remoteChecksums = syncState.remoteChecksums || {};
      await saveSyncState(context, syncState);
      backend = createRemoteBackend(context, token, syncState) ?? backend;
      logger.appendLine(
        `[${new Date().toISOString()}] Found existing remote: ${discovered.data.id}`
      );
    } else {
      const notConfiguredMessage =
        destSettings.type === "repo"
          ? "Not configured. Push first to create the sync folder in the repository."
          : "Not configured. Push first or configure a Gist ID.";
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, notConfiguredMessage, {
          direction: "pull",
          category: "not_configured",
        }),
        { title: notConfiguredMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull failed: not configured`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
      return false;
    }
  }

  progress.report({ message: "Fetching remote snapshot…" });
  const snapshotResult = await withRetry(() => backend!.getSnapshot());

  if (!snapshotResult.ok) {
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, snapshotResult.error.message, {
        direction: "pull",
        category: snapshotResult.error.category,
        statusCode: snapshotResult.error.statusCode,
      }),
      { title: `Pull failed: ${snapshotResult.error.message}` }
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Pull failed: ${snapshotResult.error.category} - ${snapshotResult.error.message}`
    );
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: false,
      error: snapshotResult.error.message,
    });
    sendEvent(context, "sync_failed", {
      direction: "pull",
      reason: snapshotResult.error.category,
      status_code: snapshotResult.error.statusCode,
      trigger,
    });
    return false;
  }

  const remoteFiles = snapshotResult.data.files;
  const manifestContent = remoteFiles["manifest.json"];
  if (!manifestContent) {
    const message =
      remoteFiles[TRANSCRIPT_MANIFEST_FILE_NAME] !== undefined
        ? "Pull failed: This remote contains agent transcripts, not settings. Use a Cursor Sync settings backup, or Import Agent Transcripts from Private Gist."
        : "Pull failed: manifest.json not found on remote.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, message, {
        direction: "pull",
        category: "missing_manifest",
      }),
      { title: message }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: missing manifest`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "missing_manifest", trigger });
    return false;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestContent) as Manifest;
  } catch {
    const invalidManifestMessage = "Pull failed: invalid manifest.json.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, invalidManifestMessage, {
        direction: "pull",
        category: "invalid_manifest",
      }),
      { title: invalidManifestMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: invalid manifest`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "invalid_manifest", trigger });
    return false;
  }

  const remoteChecksums: Record<string, string> = {};
  for (const [key, entry] of Object.entries(manifest.files)) {
    remoteChecksums[key] = entry.checksum;
  }

  progress.report({ message: "Checking for conflicts…" });
  const conflicts = await detectConflicts(context, remoteChecksums);
  if (conflicts.length > 0) {
    const unresolved = getUnresolvedConflicts(conflicts);
    if (unresolved.length > 0) {
      const conflictMessage = `${unresolved.length} conflict(s) detected. Resolve them before pulling.`;
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, conflictMessage, {
          direction: "pull",
          category: "CONFLICT",
          conflictCount: unresolved.length,
        }),
        { level: "warning", title: conflictMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull blocked: CONFLICT`);
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "pull",
        trigger,
        fileCount: 0,
        success: false,
        error: "Unresolved conflicts",
        files: unresolved.map((c) => c.relativeSyncKey).sort(),
      });
      sendEvent(context, "sync_failed", { direction: "pull", reason: "CONFLICT", trigger });
      if (trigger === "manual") {
        await vscode.commands.executeCommand("cursorSync.resolveConflicts");
      }
      return false;
    }
  }

  const extensionsKey = "cursor-user/extensions.json";
  const keepLocalExtensions =
    getResolutionForKey(extensionsKey) === "keepLocal";

  const roots = resolveSyncRoots();
  const filesToWrite: Array<{ absolutePath: string; syncKey: string; content: Buffer }> = [];

  for (const [gistFileName, fileContent] of Object.entries(remoteFiles)) {
    if (gistFileName === "manifest.json") {
      continue;
    }
    if (gistFileName === CHAT_BUNDLES_GIST_FILE_NAME) {
      continue;
    }
    if (gistFileName === CURSOR_CHAT_GIST_FILE_NAME) {
      continue;
    }

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) {
      continue;
    }

    if (isExcludedSyncKey(syncKey)) {
      continue;
    }

    if (getResolutionForKey(syncKey) === "keepLocal") {
      continue;
    }

    const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
    if (!absolutePath) {
      continue;
    }

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
      if (trigger === "manual" || trigger === "syncNow") {
        vscode.window.showInformationMessage("Pull complete: already in sync.");
      }
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "pull",
        trigger,
        fileCount: 0,
        totalFileCount: Object.keys(manifest.files).length,
        success: true,
        files: [],
      });
      const localChecksums = { ...(syncState?.localChecksums || {}) };
      for (const key of keepLocalKeys) {
        const conflict = conflicts.find((c) => c.relativeSyncKey === key);
        if (conflict) {
          localChecksums[key] = conflict.localChecksum;
        }
      }
      let alignedState: SyncState = buildSyncStateAfterWrite(
        syncState,
        backend!,
        snapshotResult.data.id,
        localChecksums,
        "pull"
      );
      alignedState = normalizeSyncStateDestination({
        ...alignedState,
        remoteChecksums,
      });
      await saveSyncState(context, alignedState);
      await clearConflicts();
      sendEvent(context, "sync_completed", { direction: "pull", file_count: 0, trigger });
      progress.report({ message: "Done" });
      await migrateAndLogSkillArtifacts();
      return true;
    }

    const keepNote =
      keepLocalKeys.size > 0
        ? ` Files marked Keep Local (${keepLocalKeys.size}) will be preserved.`
        : "";
    const choice = await vscode.window.showWarningMessage(
      `Pull will align this machine to the remote: update ${n} file(s) and delete ${m} file(s) present only locally (settings, skills, rules, …).${keepNote} Continue?`,
      { modal: true },
      "Proceed",
      "Cancel"
    );
    if (choice !== "Proceed") {
      logger.appendLine(`[${new Date().toISOString()}] Mirror pull cancelled by user`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "cancelled", trigger });
      return false;
    }
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
      return false;
    }

    const selectedKeys = new Set(selected.map((s) => s.label));
    const filtered = filesToWrite.filter((f) => selectedKeys.has(f.syncKey));
    filesToWrite.length = 0;
    filesToWrite.push(...filtered);
  }

  if (filesToWrite.length === 0 && keysToDelete.length === 0) {
    if (trigger === "manual") {
      vscode.window.showInformationMessage("Pull complete: no files to update.");
    }
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      totalFileCount: Object.keys(manifest.files).length,
      success: true,
      files: [],
    });
    const localChecksums = { ...(syncState?.localChecksums || {}) };
    for (const conflict of conflicts) {
      if (getResolutionForKey(conflict.relativeSyncKey) === "keepLocal") {
        localChecksums[conflict.relativeSyncKey] = conflict.localChecksum;
      }
    }
    let alignedState: SyncState = buildSyncStateAfterWrite(
      syncState,
      backend!,
      snapshotResult.data.id,
      localChecksums,
      "pull"
    );
    alignedState = normalizeSyncStateDestination({
      ...alignedState,
      remoteChecksums,
    });
    await saveSyncState(context, alignedState);
    await clearConflicts();
    sendEvent(context, "sync_completed", { direction: "pull", file_count: 0, trigger });
    progress.report({ message: "Done" });
    await migrateAndLogSkillArtifacts();
    return true;
  }

  const deleteAbsPaths = keysToDelete
    .map((key) => syncKeyToAbsolutePath(key, roots))
    .filter((p): p is string => Boolean(p));

  progress.report({ message: "Creating local backup…" });
  const { entries: backupEntries } = await createBackup(context, [
    ...filesToWrite.map((f) => f.absolutePath),
    ...deleteAbsPaths,
  ]);

  const writtenBackups: typeof backupEntries = [];
  let writeError = false;
  let failedSyncKey: string | undefined;
  let failedErrorDetail: string | undefined;

  progress.report({
    message: `Writing ${filesToWrite.length} file(s)…`,
  });
  for (const file of filesToWrite) {
    try {
      await ensureParentDirectory(file.absolutePath);
      const tmpPath = file.absolutePath + ".tmp";
      await fs.writeFile(tmpPath, file.content);
      await fs.rename(tmpPath, file.absolutePath);
      const backup = backupEntries.find((b) => b.absolutePath === file.absolutePath);
      if (backup) {
        writtenBackups.push(backup);
      }
    } catch (err) {
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
    await rollbackFromBackup(writtenBackups);
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
    return false;
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
    backend!,
    snapshotResult.data.id,
    newLocalChecksums,
    "pull"
  );
  newState = normalizeSyncStateDestination({
    ...newState,
    remoteChecksums,
  });
  await saveSyncState(context, newState);

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
    destination_type: backend!.type,
  });

  if (!keepLocalExtensions) {
    await syncExtensionsAfterPull(remoteFiles, logger);
    await ensureExtensionsJsonOnDisk();
    try {
      const rootsAfter = resolveSyncRoots();
      const extPath = path.join(rootsAfter.cursorUser, "extensions.json");
      const extBuf = await fs.readFile(extPath);
      const extChecksum = computeChecksum(extBuf);
      newState = {
        ...newState,
        localChecksums: {
          ...newState.localChecksums,
          [extensionsKey]: extChecksum,
        },
      };
      await saveSyncState(context, newState);
    } catch {
      // Best-effort; next sync will recompute.
    }
  }

  let chatImported = 0;
  let chatSkipped = 0;
  let chatUpdated = 0;
  if (
    isChatSyncEnabled() &&
    (remoteFiles[CURSOR_CHAT_GIST_FILE_NAME] !== undefined ||
      remoteFiles[CHAT_BUNDLES_GIST_FILE_NAME] !== undefined)
  ) {
    try {
      progress.report({ message: "Importing chat backup…" });
      const chatResult = await pullChatCollectionFromRemoteFiles(
        context,
        remoteFiles,
        progress
      );
      chatImported = chatResult.imported;
      chatSkipped = chatResult.skipped;
      chatUpdated = chatResult.updated;
      if (chatResult.warnings.length > 0) {
        for (const w of chatResult.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-sync] pull warn: ${w}`);
        }
      }
      const fingerprint = await computeChatSyncLocalFingerprint();
      await storeChatSyncFingerprint(context, fingerprint);
      const chatChecksum =
        remoteChecksums[CURSOR_CHAT_SYNC_KEY] ?? remoteChecksums[CHAT_BUNDLES_SYNC_KEY];
      const chatSyncKey = remoteChecksums[CURSOR_CHAT_SYNC_KEY]
        ? CURSOR_CHAT_SYNC_KEY
        : CHAT_BUNDLES_SYNC_KEY;
      if (chatChecksum) {
        const updatedState: SyncState = {
          ...newState,
          localChecksums: {
            ...newState.localChecksums,
            [chatSyncKey]: chatChecksum,
          },
        };
        await saveSyncState(context, updatedState);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.appendLine(`[${new Date().toISOString()}] Pull chat sync failed: ${msg}`);
      vscode.window.showWarningMessage(`Settings pulled; chat import failed: ${msg}`);
    }
  }

  const chatSuffix =
    chatImported > 0 || chatSkipped > 0 || chatUpdated > 0
      ? ` · Chats: ${chatImported} imported, ${chatSkipped} skipped${chatUpdated > 0 ? `, ${chatUpdated} updated` : ""}`
      : "";
  const deleteSuffix =
    deletedKeys.length > 0 ? `, ${deletedKeys.length} deleted` : "";
  progress.report({ message: "Done" });
  vscode.window.showInformationMessage(
    `Pull complete: ${filesToWrite.length} file(s) updated${deleteSuffix}${chatSuffix}.`
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Pull succeeded: ${filesToWrite.length} written, ${deletedKeys.length} deleted ← ${backend!.remoteLabel()}`
  );
  await migrateAndLogSkillArtifacts();
  return true;
}

const CONCURRENT_INSTALLS = 2;

async function syncExtensionsAfterPull(
  remoteFiles: Record<string, string>,
  logger: vscode.OutputChannel
): Promise<void> {
  const extContent = remoteFiles["cursor-user--extensions.json"];
  if (!extContent) {
    return;
  }

  let entries: Array<{ id: string; version: string }>;
  try {
    entries = JSON.parse(extContent) as Array<{ id: string; version: string }>;
  } catch {
    return;
  }

  const config = vscode.workspace.getConfiguration("cursorSync");
  const autoInstall = config.get<boolean>("syncExtensions.autoInstall") ?? true;
  const autoUninstall = config.get<boolean>("syncExtensions.autoUninstall") ?? false;

  const missing = findMissingExtensions(entries);
  if (autoInstall && missing.length > 0) {
    for (let i = 0; i < missing.length; i += CONCURRENT_INSTALLS) {
      const batch = missing.slice(i, i + CONCURRENT_INSTALLS);
      await Promise.all(
        batch.map(async (entry) => {
          try {
            await vscode.commands.executeCommand(
              "workbench.extensions.installExtension",
              entry.id
            );
          } catch (err) {
            logger.appendLine(
              `[${new Date().toISOString()}] Failed to install extension ${entry.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );
    }
  } else if (!autoInstall && missing.length > 0) {
    const names = missing.map((m) => m.id).join(", ");
    vscode.window.showInformationMessage(
      `Extensions present remotely but not installed locally: ${names}`
    );
  }

  const extras = findExtraExtensions(entries);
  if (extras.length === 0) {
    return;
  }

  let shouldUninstall = autoUninstall;
  if (!shouldUninstall) {
    const choice = await vscode.window.showWarningMessage(
      `Remove ${extras.length} extension(s) that are not in the synced list?`,
      "Yes",
      "No"
    );
    shouldUninstall = choice === "Yes";
  }

  if (!shouldUninstall) {
    return;
  }

  for (const id of extras) {
    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.uninstallExtension",
        id
      );
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Failed to uninstall extension ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
