import * as vscode from "vscode";
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
  isAbortError,
  isSyncAborted,
  markJournalStateWritten,
  rollbackSyncFileJournal,
  setSyncFileJournal,
  throwIfAborted,
} from "./sync-abort.js";
import { t } from "./sidebar/i18n.js";
import { migrateAndLogSkillArtifacts } from "./skill-artifacts-migrate.js";
import {
  isChatSyncEnabled,
  pullChatCollectionFromRemoteFiles,
  storeChatSyncFingerprint,
  computeChatSyncLocalFingerprint,
  readStoredChatSyncFingerprint,
  CURSOR_CHAT_GIST_FILE_NAME,
  CURSOR_CHAT_SYNC_KEY,
} from "./chat-sync.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import { computeChecksum } from "./packaging.js";
import { syncExtensionsFromRemoteFiles } from "./extensions.js";
import {
  applyCloneToCursor,
  cloneAbsForSyncKey,
  planCloneToCursor,
  pullConfirmCounts,
  withChatCollectionChecksum,
  type PullReplacePlan,
} from "./sync-copy.js";
import {
  currentHeadSha,
  ffMergeFromOrigin,
  resetCloneWorktree,
  resetHardToOrigin,
} from "./sync-clone.js";
import { buildRepoSyncState } from "./remote/destination.js";
import { blockOnRelation, failSync, prepareRepoSync, type SyncOpTrigger } from "./sync-prepare.js";
import { enterSyncLock, isSyncLocked, leaveSyncLock } from "./sync-lock.js";
import * as fs from "node:fs/promises";

export type PullTrigger = SyncOpTrigger;

export type PullOptions = {
  trigger?: PullTrigger;
  /** Discard local clone commits and match origin, then copy into Cursor. */
  resetToRemote?: boolean;
  skipLock?: boolean;
};

export function isPullLocked(): boolean {
  return isSyncLocked();
}

export async function executePull(
  context: vscode.ExtensionContext,
  options?: PullOptions
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";
  const resetToRemote = options?.resetToRemote === true;

  const lockHold = enterSyncLock({ skipLock: options?.skipLock });
  if (lockHold === "busy") {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

  updateStatusBar("syncing");
  beginSyncAbort();
  const progress = createSidebarSyncProgress("pull");
  const startedAt = Date.now();
  try {
    progress.report({
      message: resetToRemote ? "Starting reset to remote…" : "Starting pull…",
    });
    const success = await doPull(context, trigger, progress, resetToRemote);
    if (!success && isSyncAborted()) {
      await finishCancelledOperation(context, "pull", trigger);
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
      `[${new Date().toISOString()}] Pull finished in ${formatElapsedPrecise(Date.now() - startedAt)} (${success ? "ok" : "failed"}).`
    );
    updateStatusBar(success ? "ok" : "error", new Date());
    refreshSidebar();
    return success;
  } catch (err) {
    progress.complete(false);
    getLogger().appendLine(
      `[${new Date().toISOString()}] Pull finished in ${formatElapsedPrecise(Date.now() - startedAt)} (failed).`
    );
    if (isAbortError(err) || isSyncAborted()) {
      await finishCancelledOperation(context, "pull", trigger);
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
      buildSyncDebugFailure("pull", trigger, errMessage, {
        direction: "pull",
      }),
      { title: `Pull failed: ${errMessage}` }
    );
    return false;
  } finally {
    leaveSyncLock(lockHold);
    endSyncAbort();
  }
}

export async function executeResetToRemote(
  context: vscode.ExtensionContext
): Promise<boolean> {
  return executePull(context, { trigger: "manual", resetToRemote: true });
}

async function doPull(
  context: vscode.ExtensionContext,
  trigger: PullTrigger,
  progress: vscode.Progress<SyncProgressReport> & { percent?: number },
  resetToRemote: boolean
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] Pull started (trigger=${trigger}, reset=${resetToRemote})`
  );

  const prepared = await prepareRepoSync(context, "pull", trigger, progress);
  if (!prepared) {
    return false;
  }

  if (!resetToRemote) {
    const blocked = blockOnRelation(prepared.relation, "pull");
    if (blocked) {
      return failSync(context, "pull", trigger, blocked, "CONFLICT");
    }
  }

  const { clone, token } = prepared;
  if (clone.empty && !resetToRemote) {
    return failSync(
      context,
      "pull",
      trigger,
      "Remote repository has no commits yet. Push first.",
      "not_configured"
    );
  }

  const preSha = (await currentHeadSha(clone.clonePath)) ?? "HEAD";
  await resetCloneWorktree(clone.clonePath);
  setSyncFileJournal({
    backupEntries: [],
    createdPaths: [],
    previousSyncState: await loadSyncState(context),
    cloneReset: { clonePath: clone.clonePath, sha: preSha },
  });

  if (resetToRemote) {
    progress.report({ message: "Resetting clone to origin…" });
    await resetHardToOrigin(clone.clonePath, clone.identity.branch, token);
  } else {
    progress.report({ message: "Fast-forwarding clone…" });
    await ffMergeFromOrigin(clone.clonePath, clone.identity.branch);
  }

  progress.report({ message: "Comparing clone to Cursor folders…" });
  const plan = await planCloneToCursor(clone.clonePath, clone.identity.basePath);
  const counts = pullConfirmCounts(plan);
  const importChat = await chatImportNeeded(context, plan);

  if (counts.n === 0 && counts.m === 0 && counts.k === 0 && !importChat) {
    await saveCompletedState(
      context,
      clone.identity,
      withChatCollectionChecksum(plan.remoteChecksums, plan.chatRaw),
      "pull"
    );
    if (trigger === "manual" || trigger === "syncNow") {
      notifySyncQuiet("Pull complete: already in sync.");
    }
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: true,
      files: [],
    });
    return true;
  }

  if (trigger === "manual" || trigger === "syncNow") {
    const confirmMessage =
      counts.n === 0 && counts.m === 0 && counts.k === 0 && importChat
        ? t("pullReplaceConfirmChatsOnly")
        : counts.k > 0
          ? t("pullReplaceConfirm", {
              n: counts.n,
              m: counts.m,
              k: counts.k,
            })
          : t("pullReplaceConfirmFilesOnly", { n: counts.n, m: counts.m });
    const choice = await vscode.window.showWarningMessage(
      confirmMessage,
      { modal: true },
      "Proceed",
      "Cancel"
    );
    if (choice !== "Proceed") {
      logger.appendLine(`[${new Date().toISOString()}] Pull cancelled by user`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "cancelled", trigger });
      return false;
    }
  }

  throwIfAborted();
  progress.report({ message: "Writing Cursor files…" });
  const applied = await applyCloneToCursor(context, plan);
  const journal = (await import("./sync-abort.js")).getSyncFileJournal();
  setSyncFileJournal({
    backupEntries: [...(journal?.backupEntries ?? []), ...applied.backupEntries],
    createdPaths: [...(journal?.createdPaths ?? []), ...applied.createdPaths],
    directoryRestores: [
      ...(journal?.directoryRestores ?? []),
      ...applied.directoryRestores,
    ],
    previousSyncState: journal?.previousSyncState,
    cloneReset: journal?.cloneReset,
  });

  await migrateAndLogSkillArtifacts();
  await applyExtensionsFromClone(context, clone.clonePath, clone.identity.basePath, logger);

  if (importChat && plan.chatRaw !== undefined) {
    progress.report({ message: "Importing chat backup…" });
    await pullChatCollectionFromRemoteFiles(
      context,
      {
        [CURSOR_CHAT_GIST_FILE_NAME]: plan.chatRaw,
        [CHAT_BUNDLES_GIST_FILE_NAME]: plan.chatRaw,
      },
      progress
    );
    await storeChatSyncFingerprint(context, await computeChatSyncLocalFingerprint());
  }

  const next = await saveCompletedState(
    context,
    clone.identity,
    withChatCollectionChecksum(applied.checksums, plan.chatRaw),
    "pull"
  );
  markJournalStateWritten();

  const files = [...applied.writtenKeys, ...applied.deletedKeys].sort();
  await addSyncHistoryEntry(context, {
    timestamp: next.lastSyncTimestamp,
    direction: "pull",
    trigger,
    fileCount: files.length,
    totalFileCount: Object.keys(applied.checksums).length,
    success: true,
    files,
  });
  sendEvent(context, "sync_completed", {
    direction: "pull",
    trigger,
    file_count: files.length,
  });
  if (trigger === "manual" || trigger === "syncNow") {
    notifySyncQuiet(`Pulled ${applied.writtenKeys.length} file(s).`);
  }
  return true;
}

async function saveCompletedState(
  context: vscode.ExtensionContext,
  identity: {
    owner: string;
    repo: string;
    branch: string;
    basePath: string;
  },
  checksums: Record<string, string>,
  direction: "push" | "pull"
) {
  const next = buildRepoSyncState({
    previous: await loadSyncState(context),
    owner: identity.owner,
    repo: identity.repo,
    branch: identity.branch,
    basePath: identity.basePath,
    checksums,
    direction,
    completedFileSync: true,
  });
  await saveSyncState(context, next);
  return next;
}

async function applyExtensionsFromClone(
  context: vscode.ExtensionContext,
  clonePath: string,
  basePath: string,
  logger: vscode.OutputChannel
): Promise<void> {
  const nested = cloneAbsForSyncKey(clonePath, basePath, "cursor-user/extensions.json");
  let content: string | undefined;
  try {
    content = await fs.readFile(nested, "utf8");
  } catch {
    content = undefined;
  }
  if (!content) {
    return;
  }
  await syncExtensionsFromRemoteFiles(
    context,
    { "cursor-user/extensions.json": content },
    logger
  );
}

async function chatImportNeeded(
  context: vscode.ExtensionContext,
  plan: PullReplacePlan
): Promise<boolean> {
  if (!isChatSyncEnabled() || plan.chatRaw === undefined) {
    return false;
  }
  const fingerprint = await computeChatSyncLocalFingerprint();
  const stored = await readStoredChatSyncFingerprint(context);
  const cloneSum = computeChecksum(Buffer.from(plan.chatRaw, "utf8"));
  const last = (await loadSyncState(context))?.localChecksums[CURSOR_CHAT_SYNC_KEY];
  return stored !== fingerprint || last !== cloneSum;
}

export function isEmptyPullPlan(plan: PullReplacePlan): boolean {
  const c = pullConfirmCounts(plan);
  return c.n === 0 && c.m === 0 && c.k === 0;
}
