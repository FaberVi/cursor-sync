import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger, addSyncHistoryEntry, saveSyncState, loadSyncState } from "./diagnostics.js";
import { notifySyncQuiet } from "./sync-notify.js";
import { updateStatusBar, restoreStatusBarAfterCancel } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import { createSidebarSyncProgress } from "./sync-progress-events.js";
import type { SyncProgressReport } from "./sync-progress-events.js";
import { formatElapsedPrecise } from "./elapsed.js";
import {
  beginSyncAbort,
  commitSyncFileJournal,
  endSyncAbort,
  finishCancelledOperation,
  getSyncFileJournal,
  isAbortError,
  isSyncAborted,
  rollbackSyncFileJournal,
  setSyncFileJournal,
  throwIfAborted,
} from "./sync-abort.js";
import { createBackup } from "./rollback.js";
import { resolveSyncRoots } from "./paths.js";
import {
  cacheLastRemoteExtensions,
  generateExtensionsJson,
  parseExtensionEntries,
  writeExtensionsFile,
} from "./extensions.js";
import { migrateAndLogSkillArtifacts } from "./skill-artifacts-migrate.js";
import {
  isChatSyncEnabled,
  canSkipChatPackaging,
  prepareChatSyncPushPayload,
  fetchRemoteChatCollectionFromFiles,
  formatChatSyncFidelityToast,
  CURSOR_CHAT_GIST_FILE_NAME,
  storeChatSyncFingerprint,
  computeChatSyncLocalFingerprint,
} from "./chat-sync.js";
import { copyCursorToClone, readCloneChatRaw } from "./sync-copy.js";
import {
  commitCloneChanges,
  currentHeadSha,
  pushClone,
  resetCloneWorktree,
} from "./sync-clone.js";
import { buildRepoSyncState } from "./remote/destination.js";
import { blockOnRelation, failSync, prepareRepoSync, type SyncOpTrigger } from "./sync-prepare.js";
import { enterSyncLock, isSyncLocked, leaveSyncLock } from "./sync-lock.js";

export type PushTrigger = SyncOpTrigger;

export type PushOptions = {
  trigger?: PushTrigger;
  skipLock?: boolean;
};

export function isPushLocked(): boolean {
  return isSyncLocked();
}

export async function executePush(
  context: vscode.ExtensionContext,
  options?: PushOptions
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";

  const lockHold = enterSyncLock({ skipLock: options?.skipLock });
  if (lockHold === "busy") {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

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
    } else {
      await rollbackSyncFileJournal(context);
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
    await rollbackSyncFileJournal(context);
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
    leaveSyncLock(lockHold);
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

  const prepared = await prepareRepoSync(context, "push", trigger, progress);
  if (!prepared) {
    return false;
  }

  const blocked = blockOnRelation(prepared.relation, "push");
  if (blocked) {
    return failSync(context, "push", trigger, blocked, "CONFLICT");
  }

  const { clone, token } = prepared;
  const preSha = (await currentHeadSha(clone.clonePath)) ?? "HEAD";
  await resetCloneWorktree(clone.clonePath);
  setSyncFileJournal({
    backupEntries: [],
    createdPaths: [],
    previousSyncState: await loadSyncState(context),
    cloneReset: { clonePath: clone.clonePath, sha: preSha },
  });

  progress.report({ message: "Preparing local files…" });
  await writeLocalExtensionsJson(context);
  await migrateAndLogSkillArtifacts();

  let chatContent: string | undefined;
  let chatFingerprint: string | undefined;
  if (isChatSyncEnabled()) {
    const resolved = await resolveChatPushContent(
      context,
      clone.clonePath,
      clone.identity.basePath,
      progress
    );
    chatContent = resolved.content;
    chatFingerprint = resolved.fingerprint;
  }

  throwIfAborted();
  const profileName =
    vscode.workspace.getConfiguration("cursorSync").get<string>("syncProfileName") ?? "default";
  progress.report({ message: "Copying into git clone…" });
  const copied = await copyCursorToClone({
    clonePath: clone.clonePath,
    basePath: clone.identity.basePath,
    chatContent,
    profileName,
  });

  progress.report({ message: "Committing…" });
  const committed = await commitCloneChanges({
    clonePath: clone.clonePath,
    basePath: clone.identity.basePath,
    userName: prepared.userName,
    userEmail: prepared.userEmail,
  });

  if (committed) {
    progress.report({ message: "Pushing to origin…" });
    await pushClone({
      clonePath: clone.clonePath,
      branch: clone.identity.branch,
      pat: token,
      setUpstream: clone.empty || prepared.relation === "empty",
    });
  }
  const journalAfterPush = getSyncFileJournal();
  if (journalAfterPush) {
    journalAfterPush.cloneReset = undefined;
  }

  const next = buildRepoSyncState({
    previous: await loadSyncState(context),
    owner: clone.identity.owner,
    repo: clone.identity.repo,
    branch: clone.identity.branch,
    basePath: clone.identity.basePath,
    checksums: copied.checksums,
    direction: "push",
    completedFileSync: true,
  });
  await saveSyncState(context, next);
  if (chatFingerprint) {
    await storeChatSyncFingerprint(context, chatFingerprint);
  }

  const fileCount = copied.writtenKeys.length;
  await addSyncHistoryEntry(context, {
    timestamp: next.lastSyncTimestamp,
    direction: "push",
    trigger,
    fileCount,
    totalFileCount: fileCount,
    success: true,
    files: copied.writtenKeys.slice().sort(),
  });
  sendEvent(context, "sync_completed", { direction: "push", trigger, file_count: fileCount });
  if (trigger === "manual" || trigger === "scheduled" || trigger === "syncNow") {
    notifySyncQuiet(
      committed ? `Pushed ${fileCount} file(s).` : "Push complete: already in sync."
    );
  }
  return true;
}

async function writeLocalExtensionsJson(context: vscode.ExtensionContext): Promise<void> {
  const extensionsJson = generateExtensionsJson();
  try {
    const parsed = parseExtensionEntries(JSON.parse(extensionsJson));
    if (parsed) {
      await cacheLastRemoteExtensions(context, parsed);
    }
  } catch {
    // best-effort
  }
  const cursorUserRoot = resolveSyncRoots().cursorUser;
  const extensionsPath = path.join(cursorUserRoot, "extensions.json");
  const { entries: extBackups } = await createBackup(context, [extensionsPath]);
  let createdPaths: string[] = [];
  try {
    await fs.access(extensionsPath);
  } catch {
    createdPaths = [extensionsPath];
  }
  const journal = (await import("./sync-abort.js")).getSyncFileJournal();
  setSyncFileJournal({
    backupEntries: [...(journal?.backupEntries ?? []), ...extBackups],
    createdPaths: [...(journal?.createdPaths ?? []), ...createdPaths],
    previousSyncState: journal?.previousSyncState,
    cloneReset: journal?.cloneReset,
  });
  await writeExtensionsFile(cursorUserRoot, extensionsJson);
}

async function resolveChatPushContent(
  context: vscode.ExtensionContext,
  clonePath: string,
  basePath: string,
  progress: vscode.Progress<SyncProgressReport>
): Promise<{ content?: string; fingerprint?: string }> {
  const syncState = await loadSyncState(context);
  const remoteChecksums = syncState?.remoteChecksums ?? {};
  const skip = await canSkipChatPackaging(context, remoteChecksums, syncState);
  if (skip) {
    progress.report({ message: "Chat backup unchanged…" });
    return { content: await readCloneChatRaw(clonePath, basePath) };
  }
  progress.report({ message: "Preparing chat backup…" });
  const payload = await prepareChatSyncPushPayload(context, async () => {
    const raw = await readCloneChatRaw(clonePath, basePath);
    if (raw === undefined) {
      return null;
    }
    return fetchRemoteChatCollectionFromFiles(context, {
      [CURSOR_CHAT_GIST_FILE_NAME]: raw,
    });
  }, progress);
  if (!payload) {
    return { content: await readCloneChatRaw(clonePath, basePath) };
  }
  const toast = formatChatSyncFidelityToast(payload.fidelityReport);
  if (toast) {
    getLogger().appendLine(`[${new Date().toISOString()}] [chat-sync] ${toast}`);
  }
  return {
    content: payload.content,
    fingerprint: await computeChatSyncLocalFingerprint(),
  };
}
