import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { enumerateSyncFiles, syncKeyToGistFileName, resolveSyncRoots } from "./paths.js";
import { migrateAndLogSkillArtifacts } from "./skill-artifacts-migrate.js";
import { packageFiles } from "./packaging.js";
import { requireToken, validateStoredToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import {
  detectConflicts,
  clearConflicts,
  getUnresolvedConflicts,
  getResolutionForKey,
} from "./conflicts.js";
import { generateExtensionsJson } from "./extensions.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import {
  CURSOR_CHAT_GIST_FILE_NAME,
  CURSOR_CHAT_SYNC_KEY,
  formatChatSyncFidelityToast,
  isChatSyncEnabled,
  prepareChatSyncPushPayload,
  storeChatSyncFingerprint,
  computeChatSyncLocalFingerprint,
  fetchRemoteChatCollectionFromFiles,
  canSkipChatPackaging,
} from "./chat-sync.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import {
  buildSyncStateAfterWrite,
  createRemoteBackend,
  readDestinationSettings,
  remoteSnapshotFileNames,
  RepoBackend,
} from "./remote/index.js";
import { ensureRepoExistsInteractive } from "./remote/ensure-repo.js";
import { selectPushDelta } from "./push-delta.js";
import { createSidebarSyncProgress } from "./sync-progress-events.js";
import { ensureParentDirectory } from "./rollback.js";
import type { ManifestFileEntry, SyncState } from "./types.js";
import * as path from "node:path";

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
  const progress = createSidebarSyncProgress("push");
  try {
    progress.report({ message: "Starting push…" });
    const success = await doPush(context, trigger, progress);
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
    pushLock = false;
  }
}

async function doPush(
  context: vscode.ExtensionContext,
  trigger: PushTrigger = "manual",
  progress: vscode.Progress<{ message?: string; increment?: number }> = {
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
  const snapshotResult = await withRetry(() =>
    backend.getSnapshot({ onlyFiles: ["manifest.json"] })
  );
  let remoteChecksums: Record<string, string> = syncState?.remoteChecksums
    ? { ...syncState.remoteChecksums }
    : {};
  let remoteManifestFiles: Record<string, ManifestFileEntry> = {};
  let existingRemoteNames: string[] = [];
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

  let keepRemoteKeys = new Set<string>();
  if (syncState) {
    progress.report({ message: "Checking for conflicts…" });
    const conflicts = await detectConflicts(context, remoteChecksums);
    if (conflicts.length > 0) {
      const unresolved = getUnresolvedConflicts(conflicts);
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
        if (trigger === "manual") {
          await vscode.commands.executeCommand("cursorSync.resolveConflicts");
        }
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

  progress.report({ message: "Packaging local files…" });
  const extensionsKey = "cursor-user/extensions.json";
  if (!keepRemoteKeys.has(extensionsKey)) {
    const extensionsJson = generateExtensionsJson();
    const cursorUserRoot = resolveSyncRoots().cursorUser;
    await writeExtensionsFile(cursorUserRoot, extensionsJson);
  }

  await migrateAndLogSkillArtifacts();

  const files = await enumerateSyncFiles();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const profileName = config.get<string>("syncProfileName") ?? "default";
  const { packaged, manifest, skipped } = await packageFiles(files, profileName);
  if (skipped.length > 0) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skipping ${skipped.length} empty/whitespace-only file(s) (GitHub Gist rejects them):`
    );
    for (const item of skipped) {
      logger.appendLine(`  - ${item.relativeSyncKey} (${item.reason})`);
    }
  }

  for (const key of keepRemoteKeys) {
    packaged.delete(key);
    const remoteChecksum = remoteChecksums[key];
    if (remoteChecksum) {
      const remoteEntry = remoteManifestFiles[key];
      manifest.files[key] = {
        checksum: remoteChecksum,
        sizeBytes: remoteEntry?.sizeBytes ?? 0,
      };
    } else {
      delete manifest.files[key];
    }
  }

  let chatBundleCount = 0;
  let pushNativeChatFile = false;
  let chatForDelta:
    | {
        syncKey: string;
        gistFileName: string;
        checksum: string;
        content: string;
      }
    | undefined;
  if (isChatSyncEnabled()) {
    const skipChat = await canSkipChatPackaging(
      context,
      remoteChecksums,
      syncState ?? undefined
    );
    if (skipChat) {
      progress.report({ message: "Chat backup unchanged…" });
      const remoteEntry = remoteManifestFiles[CURSOR_CHAT_SYNC_KEY];
      const checksum = remoteChecksums[CURSOR_CHAT_SYNC_KEY]!;
      manifest.files[CURSOR_CHAT_SYNC_KEY] = {
        checksum,
        sizeBytes: remoteEntry?.sizeBytes ?? 0,
      };
      chatForDelta = {
        syncKey: CURSOR_CHAT_SYNC_KEY,
        gistFileName: CURSOR_CHAT_GIST_FILE_NAME,
        checksum,
        content: "",
      };
      pushNativeChatFile = true;
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-sync] skipped packaging (fingerprint unchanged)`
      );
    } else {
      progress.report({ message: "Preparing chat backup…" });
      try {
        const chatPayload = await prepareChatSyncPushPayload(
          context,
          async () => {
            const chatSnap = await withRetry(() =>
              backend.getSnapshot({
                onlyFiles: [
                  CURSOR_CHAT_GIST_FILE_NAME,
                  CHAT_BUNDLES_GIST_FILE_NAME,
                ],
              })
            );
            if (!chatSnap.ok) {
              return null;
            }
            return fetchRemoteChatCollectionFromFiles(
              context,
              chatSnap.data.files
            );
          },
          { report: (value) => progress.report(value) }
        );
        if (chatPayload) {
          manifest.files[chatPayload.syncKey] = {
            checksum: chatPayload.checksum,
            sizeBytes: chatPayload.sizeBytes,
          };
          chatBundleCount = chatPayload.bundleCount;
          pushNativeChatFile =
            chatPayload.gistFileName === CURSOR_CHAT_GIST_FILE_NAME;
          chatForDelta = {
            syncKey: chatPayload.syncKey,
            gistFileName: chatPayload.gistFileName,
            checksum: chatPayload.checksum,
            content: chatPayload.content,
          };
          const fidelity = chatPayload.fidelityReport;
          const lowTier =
            fidelity.byTier.archive + fidelity.byTier.partial;
          if (lowTier > 0 || fidelity.textOnlyLayer4 > 0) {
            const detail = formatChatSyncFidelityToast(fidelity);
            logger.appendLine(
              `[${new Date().toISOString()}] [chat-sync] push fidelity: ${detail}`
            );
            void vscode.window
              .showWarningMessage(
                `Chat sync: ${detail}. See Output for details.`,
                "Show Output"
              )
              .then((choice) => {
                if (choice === "Show Output") {
                  logger.show();
                }
              });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(
          `[${new Date().toISOString()}] Push chat sync skipped: ${msg}`
        );
        vscode.window.showWarningMessage(
          `Settings push continues; chat sync skipped: ${msg}`
        );
      }
    }
  }

  const delta = selectPushDelta({
    packaged,
    remoteChecksums,
    existingRemoteNames,
    forceFullUpload,
    chat: chatForDelta,
    pushNativeChatFile,
    chatSyncEnabled: isChatSyncEnabled(),
    legacyChatBundlesFileName: CHAT_BUNDLES_GIST_FILE_NAME,
    preserveSyncKeys: keepRemoteKeys,
  });

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
  const writeResult = await withRetry(() =>
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
  for (const [key, value] of packaged) {
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

async function writeExtensionsFile(
  cursorUserRoot: string,
  content: string
): Promise<string> {
  const filePath = path.join(cursorUserRoot, "extensions.json");
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
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
