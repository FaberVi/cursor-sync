import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger, saveSyncState } from "./diagnostics.js";
import { notifySyncQuiet } from "./sync-notify.js";
import { resolveSyncRoots } from "./paths.js";
import { migrateAndLogSkillArtifacts } from "./skill-artifacts-migrate.js";
import { computeChecksum } from "./packaging.js";
import { ensureExtensionsJsonOnDisk, clearLastRemoteExtensions, syncExtensionsFromRemoteFiles } from "./extensions.js";
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
import type { SyncProgressReport } from "./sync-progress-events.js";
import type { SyncState } from "./types.js";
import type { PullTrigger, PullRemoteFetchSuccess } from "./pull-remote-fetch.js";
import type { PullApplyWritten } from "./pull-apply-files.js";

export async function applyRemoteExtensionSync(
  context: vscode.ExtensionContext,
  remoteFiles: Record<string, string>,
  logger: vscode.OutputChannel,
  keepLocal: boolean,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
  if (keepLocal) {
    await clearLastRemoteExtensions(context);
    return;
  }
  progress.report({ message: "Checking extensions…" });
  await syncExtensionsFromRemoteFiles(context, remoteFiles, logger);
}

export async function finishPullChatImport(
  context: vscode.ExtensionContext,
  trigger: PullTrigger,
  progress: vscode.Progress<SyncProgressReport> & { percent?: number },
  fetched: PullRemoteFetchSuccess,
  applied: PullApplyWritten
): Promise<boolean> {
  const logger = getLogger();
  const { backend, remoteChecksums, remoteFiles } = fetched;
  const { filesToWrite, deletedKeys, keepLocalExtensions } = applied;
  let newState: SyncState = applied.newState;
  const extensionsKey = "cursor-user/extensions.json";

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
        newState = {
          ...newState,
          localChecksums: {
            ...newState.localChecksums,
            [chatSyncKey]: chatChecksum,
          },
        };
        await saveSyncState(context, newState);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.appendLine(`[${new Date().toISOString()}] Pull chat sync failed: ${msg}`);
      vscode.window.showWarningMessage(`Settings pulled; chat import failed: ${msg}`);
    }
  }

  await applyRemoteExtensionSync(
    context,
    remoteFiles,
    logger,
    keepLocalExtensions,
    progress
  );
  if (!keepLocalExtensions) {
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

  const chatSuffix =
    chatImported > 0 || chatSkipped > 0 || chatUpdated > 0
      ? ` · Chats: ${chatImported} imported, ${chatSkipped} skipped${chatUpdated > 0 ? `, ${chatUpdated} updated` : ""}`
      : "";
  const deleteSuffix =
    deletedKeys.length > 0 ? `, ${deletedKeys.length} deleted` : "";
  progress.report({ message: "Done" });
  notifySyncQuiet(
    `Pull complete: ${filesToWrite.length} file(s) updated${deleteSuffix}${chatSuffix}.`
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Pull succeeded: ${filesToWrite.length} written, ${deletedKeys.length} deleted ← ${backend.remoteLabel()}`
  );
  await migrateAndLogSkillArtifacts();
  return true;
}
