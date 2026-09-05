import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import {
  rollbackFromBackup,
  unlinkCreatedFiles,
  restoreSkillDirectories,
  pathIsInsideDirectory,
  type BackupEntry,
  type DirectoryRestore,
} from "./rollback.js";
import { saveSyncState, addSyncHistoryEntry } from "./diagnostics.js";
import type { SyncState } from "./types.js";

export class SyncCancelledError extends Error {
  readonly category = "CANCELLED" as const;

  constructor(message = "cancelled") {
    super(message);
    this.name = "SyncCancelledError";
  }
}

export type CloneResetSpec = {
  clonePath: string;
  sha: string;
};

export type SyncFileJournal = {
  backupEntries: BackupEntry[];
  createdPaths: string[];
  directoryRestores?: DirectoryRestore[];
  previousSyncState?: SyncState;
  previousSyncStateWritten?: boolean;
  cloneReset?: CloneResetSpec;
};

let abortRefCount = 0;
let controller: AbortController | undefined;
let journal: SyncFileJournal | undefined;
const liveChildren = new Set<ChildProcess>();

export function beginSyncAbort(): AbortSignal {
  if (abortRefCount === 0 || !controller) {
    controller = new AbortController();
  }
  abortRefCount += 1;
  return controller.signal;
}

export function endSyncAbort(): void {
  abortRefCount = Math.max(0, abortRefCount - 1);
  if (abortRefCount === 0) {
    controller = undefined;
    journal = undefined;
    liveChildren.clear();
  }
}

export function getSyncAbortSignal(): AbortSignal | undefined {
  return controller?.signal;
}

export function isSyncAborted(): boolean {
  return controller?.signal.aborted === true;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof SyncCancelledError) {
    return true;
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  return false;
}

export function throwIfAborted(): void {
  if (controller?.signal.aborted) {
    throw new SyncCancelledError();
  }
}

export function requestSyncCancel(): boolean {
  if (!controller || abortRefCount <= 0) {
    return false;
  }
  if (!controller.signal.aborted) {
    controller.abort();
  }
  killLiveChildren();
  return true;
}

export function executeCancelSyncCommand(): void {
  if (!requestSyncCancel()) {
    vscode.window.showInformationMessage("No sync in progress.");
  }
}

export function setSyncFileJournal(next: SyncFileJournal): void {
  journal = next;
}

export function getSyncFileJournal(): SyncFileJournal | undefined {
  return journal;
}

export function commitSyncFileJournal(): void {
  journal = undefined;
}

export function markJournalStateWritten(): void {
  if (journal) {
    journal.previousSyncStateWritten = true;
  }
}

export async function rollbackSyncFileJournal(
  context?: vscode.ExtensionContext
): Promise<number> {
  const current = journal;
  journal = undefined;
  if (!current) {
    return 0;
  }
  if (current.cloneReset) {
    try {
      const { gitResetHard, gitCleanFd } = await import("./git-cli.js");
      await gitResetHard(current.cloneReset.clonePath, current.cloneReset.sha);
      await gitCleanFd(current.cloneReset.clonePath);
    } catch {
      // Clone reset is best-effort; Cursor journal rollback still runs.
    }
  }
  const restoredDirs = await restoreSkillDirectories(current.directoryRestores ?? []);
  const skipPath = (absPath: string): boolean =>
    restoredDirs.some((entry) => pathIsInsideDirectory(absPath, entry.absolutePath));
  const fileBackups = current.backupEntries.filter((entry) => !skipPath(entry.absolutePath));
  const createdPaths = current.createdPaths.filter((absPath) => !skipPath(absPath));
  await rollbackFromBackup(fileBackups);
  const unlinked = await unlinkCreatedFiles(createdPaths);
  if (context && current.previousSyncStateWritten && current.previousSyncState) {
    await saveSyncState(context, current.previousSyncState);
  }
  return fileBackups.length + unlinked + restoredDirs.length;
}

export async function finishCancelledOperation(
  context: vscode.ExtensionContext,
  direction: "push" | "pull",
  trigger: "manual" | "scheduled" | "syncNow"
): Promise<number> {
  const restored = await rollbackSyncFileJournal(context);
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction,
    trigger,
    fileCount: 0,
    success: false,
    error: "cancelled",
    files: [],
  });
  vscode.window.showWarningMessage(
    `Sync stopped; ${restored} local file(s) restored.`
  );
  return restored;
}

export function registerLivePythonProcess(proc: ChildProcess | undefined): void {
  registerLiveChildProcess(proc);
}

export function registerLiveChildProcess(proc: ChildProcess | undefined): void {
  if (!proc) {
    return;
  }
  liveChildren.add(proc);
  const drop = (): void => {
    liveChildren.delete(proc);
  };
  proc.once("exit", drop);
  proc.once("close", drop);
}

export function killChildProcess(proc: ChildProcess): void {
  if (proc.killed) {
    liveChildren.delete(proc);
    return;
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
  if (process.platform === "win32" && proc.pid) {
    execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], () => undefined);
  }
}

function killLiveChildren(): void {
  for (const proc of [...liveChildren]) {
    killChildProcess(proc);
  }
}

export const cancelledApiError = {
  category: "CANCELLED" as const,
  message: "cancelled",
};
