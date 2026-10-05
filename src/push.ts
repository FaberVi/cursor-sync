import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getLogger,
  addSyncHistoryEntry,
  saveSyncState,
  loadSyncState,
  syncHistoryFromOperations,
} from "./diagnostics.js";
import { notifySyncQuiet } from "./sync-notify.js";
import { updateStatusBar, restoreStatusBarAfterCancel } from "./statusbar.js";
import { recordLocalDiffers, removedSyncKeys } from "./cursor-differs.js";
import { syncStatusBarWithRemoteAheadCache } from "./remote-ahead.js";
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
  ensureExtensionsJsonOnDisk,
  parseExtensionEntries,
  prepareExtensionsJsonForSync,
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
import { copyCursorToClone, hashCloneSyncFiles, hashCursorSyncFiles, readCloneChatRaw } from "./sync-copy.js";
import { pendingDeletionsAfterPush } from "./intentional-deletions.js";
import {
  commitCloneChanges,
  currentHeadSha,
  pushClone,
  rebaseOntoOrigin,
  relationToOrigin,
  resetCloneWorktree,
} from "./sync-clone.js";
import { buildRepoSyncState } from "./remote/destination.js";
import { shouldStageDeletionsBeforePull } from "./sync-action.js";
import { gitResetHard } from "./git-cli.js";
import { blockOnRelation, failSync, prepareRepoSync, type SyncOpTrigger } from "./sync-prepare.js";
import { isSyncLocked, leaveSyncLock } from "./sync-lock.js";
import { acquireSyncOperationLock } from "./sync-lock-acquire.js";

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

  const lockHold = await acquireSyncOperationLock(context, { skipLock: options?.skipLock });
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
    if (success) {
      recordLocalDiffers(false);
      syncStatusBarWithRemoteAheadCache(new Date(), { includeSyncing: true });
    } else {
      updateStatusBar("error", new Date());
    }
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
    void import("./remote-ahead.js").then((mod) => mod.onSyncLockReleased(context));
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

  const relationAfterCommit = await relationToOrigin(clone.clonePath, clone.identity.branch);
  if (committed || relationAfterCommit === "ahead") {
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

  const previousState = await loadSyncState(context);
  const cloneChecksums = await hashCloneSyncFiles(clone.clonePath, clone.identity.basePath);
  const next = buildRepoSyncState({
    previous: previousState,
    owner: clone.identity.owner,
    repo: clone.identity.repo,
    branch: clone.identity.branch,
    basePath: clone.identity.basePath,
    checksums: copied.checksums,
    direction: "push",
    completedFileSync: true,
    pendingDeletions: pendingDeletionsAfterPush({
      pending: previousState?.pendingDeletions,
      writtenChecksums: copied.checksums,
      cloneChecksums,
    }),
  });
  await saveSyncState(context, next);
  if (chatFingerprint) {
    await storeChatSyncFingerprint(context, chatFingerprint);
  }

  const createdOnPush = new Set(copied.createdKeys);
  const historyFiles = syncHistoryFromOperations({
    created: copied.createdKeys,
    updated: copied.writtenKeys.filter((key) => !createdOnPush.has(key)),
    deleted: copied.deletedKeys,
  });
  await addSyncHistoryEntry(context, {
    timestamp: next.lastSyncTimestamp,
    direction: "push",
    trigger,
    fileCount: historyFiles.fileCount,
    totalFileCount: Math.max(Object.keys(copied.checksums).length, historyFiles.fileCount),
    success: true,
    files: historyFiles.files,
    operations: historyFiles.operations,
  });
  sendEvent(context, "sync_completed", {
    direction: "push",
    trigger,
    file_count: historyFiles.fileCount,
  });
  if (trigger === "manual" || trigger === "scheduled" || trigger === "syncNow") {
    notifySyncQuiet(
      committed
        ? `Pushed ${copied.writtenKeys.length} file(s).`
        : "Push complete: already in sync."
    );
  }
  const { recordRemoteRelation } = await import("./remote-ahead.js");
  recordRemoteRelation({ relation: "equal" });
  return true;
}

export type StagedDeletions =
  | { status: "skipped" }
  | { status: "failed" }
  | {
      status: "staged";
      clonePath: string;
      branch: string;
      token: string;
      preSha: string;
    };

/**
 * When origin is ahead and Cursor deleted synced files, commit that deletion
 * on the current clone HEAD and rebase it onto origin before any pull copies
 * files back. Does not push and does not update sync state.
 */
export async function stageDeletionsAndRebase(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<SyncProgressReport>
): Promise<StagedDeletions> {
  const prepared = await prepareRepoSync(context, "push", "syncNow", progress);
  if (!prepared || prepared.clone.empty) {
    return { status: "skipped" };
  }
  await ensureExtensionsJsonOnDisk();
  const { restoreVacantSkillFoldersFromClone } = await import(
    "./restore-vacant-skill-folders.js"
  );
  await restoreVacantSkillFoldersFromClone({
    clonePath: prepared.clone.clonePath,
    basePath: prepared.clone.identity.basePath,
  });
  const localHashes = await hashCursorSyncFiles();
  const cloneHashes = await hashCloneSyncFiles(
    prepared.clone.clonePath,
    prepared.clone.identity.basePath
  );
  const removed = removedSyncKeys(localHashes, cloneHashes);
  if (!shouldStageDeletionsBeforePull(prepared.relation, removed.length)) {
    return { status: "skipped" };
  }

  const preSha = (await currentHeadSha(prepared.clone.clonePath)) ?? "HEAD";
  await resetCloneWorktree(prepared.clone.clonePath);
  progress.report({ message: "Recording local deletions…" });
  await writeLocalExtensionsJson(context);
  await migrateAndLogSkillArtifacts();
  let chatContent: string | undefined;
  if (isChatSyncEnabled()) {
    chatContent = (await resolveChatPushContent(
      context,
      prepared.clone.clonePath,
      prepared.clone.identity.basePath,
      progress
    )).content;
  }
  const profileName =
    vscode.workspace.getConfiguration("cursorSync").get<string>("syncProfileName") ?? "default";
  await copyCursorToClone({
    clonePath: prepared.clone.clonePath,
    basePath: prepared.clone.identity.basePath,
    chatContent,
    profileName,
  });
  const committed = await commitCloneChanges({
    clonePath: prepared.clone.clonePath,
    basePath: prepared.clone.identity.basePath,
    userName: prepared.userName,
    userEmail: prepared.userEmail,
  });
  if (!committed) {
    return { status: "skipped" };
  }
  try {
    progress.report({ message: "Replaying local deletions onto origin…" });
    await rebaseOntoOrigin(prepared.clone.clonePath, prepared.clone.identity.branch);
  } catch (err) {
    await gitResetHard(prepared.clone.clonePath, preSha);
    const message = err instanceof Error ? err.message : String(err);
    await failSync(context, "push", "syncNow", message, "CONFLICT");
    return { status: "failed" };
  }
  return {
    status: "staged",
    clonePath: prepared.clone.clonePath,
    branch: prepared.clone.identity.branch,
    token: prepared.token,
    preSha,
  };
}

async function writeLocalExtensionsJson(context: vscode.ExtensionContext): Promise<void> {
  const extensionsJson = await prepareExtensionsJsonForSync();
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
