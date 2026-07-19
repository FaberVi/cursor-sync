import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { enumerateSyncFiles, syncKeyToGistFileName } from "./paths.js";
import { packageFiles, computeChecksum } from "./packaging.js";
import { GistClient } from "./gist.js";
import { requireToken, validateStoredToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { detectConflicts, clearConflicts, getPendingConflicts, getResolutionForKey } from "./conflicts.js";
import { generateExtensionsJson } from "./extensions.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import {
  CHAT_BUNDLES_SYNC_KEY,
  CURSOR_CHAT_GIST_FILE_NAME,
  CURSOR_CHAT_SYNC_KEY,
  formatChatSyncFidelityToast,
  isChatSyncEnabled,
  prepareChatSyncPushPayload,
  storeChatSyncFingerprint,
  computeChatSyncLocalFingerprint,
} from "./chat-sync.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import type { SyncState } from "./types.js";

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
  const logger = getLogger();

  if (pushLock) {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

  pushLock = true;
  updateStatusBar("syncing");
  try {
    const success = await doPush(context, trigger);
    updateStatusBar(success ? "ok" : "error", new Date());
    refreshSidebar();
    return success;
  } catch (err) {
    updateStatusBar("error", new Date());
    refreshSidebar();
    throw err;
  } finally {
    pushLock = false;
  }
}

async function doPush(
  context: vscode.ExtensionContext,
  trigger: PushTrigger = "manual"
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Push started`);

  const authFailedMessage =
    "GitHub token not configured. Configure your token to sync.";

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
    sendEvent(context, "sync_failed", { direction: "push", reason: "AUTH_FAILED", trigger });
    return false;
  }

  const client = new GistClient(token);
  const syncState = await loadSyncState(context);

  if (syncState) {
    let remoteChecksums = syncState.remoteChecksums;
    if (syncState.gistId) {
      const gistResult = await withRetry(() => client.getGist(syncState.gistId));
      if (gistResult.ok) {
        const manifestFile = gistResult.data.files["manifest.json"];
        if (manifestFile) {
          try {
            const manifest = JSON.parse(manifestFile.content) as {
              files: Record<string, { checksum: string }>;
            };
            remoteChecksums = {};
            for (const [key, entry] of Object.entries(manifest.files)) {
              remoteChecksums[key] = entry.checksum;
            }
          } catch {
            // Fall back to last-known remote checksums.
          }
        }
      }
    }
    const conflicts = await detectConflicts(context, remoteChecksums);
    if (conflicts.length > 0) {
      const unresolved = conflicts.filter((c) => {
        const resolution = getResolutionForKey(c.relativeSyncKey);
        return !resolution || resolution === "skip";
      });
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
        sendEvent(context, "sync_failed", { direction: "push", reason: "CONFLICT", trigger });
        if (trigger === "manual") {
          await vscode.commands.executeCommand("cursorSync.resolveConflicts");
        }
        return false;
      }
    }
  }

  const extensionsJson = generateExtensionsJson();
  const cursorUserRoot = (await import("./paths.js")).resolveSyncRoots().cursorUser;
  await writeExtensionsFile(cursorUserRoot, extensionsJson);

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

  const gistFiles: Record<string, { content: string }> = {};
  let chatBundleCount = 0;
  let pushNativeChatFile = false;
  if (isChatSyncEnabled()) {
    try {
      const chatPayload = await prepareChatSyncPushPayload(
        context,
        syncState?.gistId,
        token,
        { report: () => {} }
      );
      if (chatPayload) {
        manifest.files[chatPayload.syncKey] = {
          checksum: chatPayload.checksum,
          sizeBytes: chatPayload.sizeBytes,
        };
        chatBundleCount = chatPayload.bundleCount;
        gistFiles[chatPayload.gistFileName] = { content: chatPayload.content };
        pushNativeChatFile = chatPayload.gistFileName === CURSOR_CHAT_GIST_FILE_NAME;
        pushNativeChatFile = chatPayload.gistFileName === CURSOR_CHAT_GIST_FILE_NAME;
        const fidelity = chatPayload.fidelityReport;
        const lowTier =
          fidelity.byTier.archive + fidelity.byTier.partial;
        if (lowTier > 0 || fidelity.textOnlyLayer4 > 0) {
          const detail = formatChatSyncFidelityToast(fidelity);
          logger.appendLine(
            `[${new Date().toISOString()}] [chat-sync] push fidelity: ${detail}`
          );
          void vscode.window.showWarningMessage(
            `Chat sync: ${detail}. See Output for details.`,
            "Show Output"
          ).then((choice) => {
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
      vscode.window.showWarningMessage(`Settings push continues; chat sync skipped: ${msg}`);
    }
  }

  gistFiles["manifest.json"] = { content: JSON.stringify(manifest, null, 2) };

  for (const [key, value] of packaged) {
    const gistFileName = syncKeyToGistFileName(key);
    gistFiles[gistFileName] = { content: value.content };
  }

  let gistId = syncState?.gistId;
  let isNewGist = false;

  if (!gistId) {
    const existingResult = await withRetry(() => client.findExistingGist());
    if (existingResult.ok && existingResult.data) {
      gistId = existingResult.data.id;
    }
  }

  if (!gistId) {
    const result = await withRetry(() =>
      client.createGist(gistFiles, "Cursor Sync - Settings Backup")
    );
    if (!result.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("push", trigger, result.error.message, {
          direction: "push",
          category: result.error.category,
          statusCode: result.error.statusCode,
        }),
        { title: `Push failed: ${result.error.message}` }
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Push failed: ${result.error.category} - ${result.error.message}`
      );
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: 0,
        success: false,
        error: result.error.message,
        files: [...packaged.keys()].sort(),
      });
      sendEvent(context, "sync_failed", {
        direction: "push",
        reason: result.error.category,
        trigger,
        status_code: result.error.statusCode,
      });
      return false;
    }
    gistId = result.data.id;
    isNewGist = true;
  } else {
    const existingResult = await withRetry(() => client.getGist(gistId!));
    let filesToDelete: Record<string, null> = {};
    if (existingResult.ok) {
      const existingFiles = Object.keys(existingResult.data.files);
      for (const existing of existingFiles) {
        if (existing === "manifest.json" || gistFiles[existing]) {
          continue;
        }
        if (existing === CHAT_BUNDLES_GIST_FILE_NAME && !isChatSyncEnabled()) {
          continue;
        }
        filesToDelete[existing] = null;
      }
      if (pushNativeChatFile) {
        filesToDelete[CHAT_BUNDLES_GIST_FILE_NAME] = null;
      }
    }

    const updatePayload: Record<string, { content: string } | null> = {
      ...gistFiles,
      ...filesToDelete,
    };

    const result = await withRetry(() =>
      client.updateGist(gistId!, updatePayload)
    );
    if (!result.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("push", trigger, result.error.message, {
          direction: "push",
          category: result.error.category,
          statusCode: result.error.statusCode,
        }),
        { title: `Push failed: ${result.error.message}` }
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Push failed: ${result.error.category} - ${result.error.message}`
      );
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: 0,
        success: false,
        error: result.error.message,
        files: [...packaged.keys()].sort(),
      });
      sendEvent(context, "sync_failed", {
        direction: "push",
        reason: result.error.category,
        trigger,
        status_code: result.error.statusCode,
      });
      return false;
    }
  }

  const checksums: Record<string, string> = {};
  for (const [key, value] of packaged) {
    checksums[key] = value.checksum;
  }
  if (gistFiles[CURSOR_CHAT_GIST_FILE_NAME]) {
    const chatEntry = manifest.files[CURSOR_CHAT_SYNC_KEY];
    if (chatEntry) {
      checksums[CURSOR_CHAT_SYNC_KEY] = chatEntry.checksum;
    }
  } else if (gistFiles[CHAT_BUNDLES_GIST_FILE_NAME]) {
    const chatEntry = manifest.files[CHAT_BUNDLES_SYNC_KEY];
    if (chatEntry) {
      checksums[CHAT_BUNDLES_SYNC_KEY] = chatEntry.checksum;
    }
  }

  const newState: SyncState = {
    lastSyncTimestamp: new Date().toISOString(),
    lastSyncDirection: "push",
    gistId: gistId!,
    localChecksums: checksums,
    remoteChecksums: checksums,
  };
  await saveSyncState(context, newState);
  if (isChatSyncEnabled()) {
    const fingerprint = await computeChatSyncLocalFingerprint();
    await storeChatSyncFingerprint(context, fingerprint);
  }
  clearConflicts();

  const historyFiles = [...packaged.keys()].sort();
  const fileCount = historyFiles.length;
  const chatSuffix =
    chatBundleCount > 0 ? ` · ${chatBundleCount} chat(s)` : "";
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "push",
    trigger,
    fileCount,
    success: true,
    files: historyFiles,
  });
  sendEvent(context, "sync_completed", {
    direction: "push",
    file_count: fileCount,
    trigger,
    is_new_gist: isNewGist,
  });
  vscode.window.showInformationMessage(
    `Push complete: ${fileCount} file(s) synced${chatSuffix}.`
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Push succeeded: ${fileCount} files`
  );
  return true;
}

async function writeExtensionsFile(
  cursorUserRoot: string,
  content: string
): Promise<string> {
  const filePath = (await import("node:path")).join(
    cursorUserRoot,
    "extensions.json"
  );
  const dir = (await import("node:path")).dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}
