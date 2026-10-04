import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./sidebar/i18n.js";
import { resolveSyncRoots } from "./paths.js";
import { pathIsInsideDirectory } from "./rollback.js";
import { getSyncClonePath, readRepoIdentity } from "./sync-clone.js";
import { cloneAbsForSyncKey, cloneBaseAbs } from "./sync-copy.js";
import { syncKeyToAbsolutePath } from "./sync-local-deletes.js";
import type { FileChangeKind } from "./cursor-differs.js";

export type SyncKeyPreviewChange = FileChangeKind | "incoming";

export type SyncKeyPreviewEntry = {
  syncKey: string;
  change?: SyncKeyPreviewChange;
};

export function syncKeyChangeLabel(
  change: SyncKeyPreviewChange | undefined
): string | undefined {
  if (!change) {
    return undefined;
  }
  const key =
    change === "added"
      ? "fileChangeAdded"
      : change === "removed"
        ? "fileChangeRemoved"
        : change === "incoming"
          ? "fileChangeIncoming"
          : "fileChangeModified";
  return t(key);
}

function isConfinedSyncPath(candidate: string, roots: readonly string[]): string | undefined {
  const resolved = path.resolve(candidate);
  if (!roots.some((root) => pathIsInsideDirectory(resolved, root))) {
    return undefined;
  }
  return resolved;
}

/** Local Cursor file first, then the same path inside the sync clone. */
export function syncKeyOpenCandidates(
  syncKey: string,
  roots: { cursorUser: string; dotCursor: string },
  clone?: { clonePath: string; basePath: string }
): string[] {
  if (syncKey.split("/").includes("..")) {
    return [];
  }
  const allowed = [roots.cursorUser, roots.dotCursor];
  if (clone) {
    allowed.push(cloneBaseAbs(clone.clonePath, clone.basePath));
  }
  const raw: string[] = [];
  const local = syncKeyToAbsolutePath(syncKey, roots);
  if (local) {
    raw.push(local);
  }
  if (clone) {
    raw.push(cloneAbsForSyncKey(clone.clonePath, clone.basePath, syncKey));
  }
  const confined: string[] = [];
  for (const candidate of raw) {
    const safe = isConfinedSyncPath(candidate, allowed);
    if (safe) {
      confined.push(safe);
    }
  }
  return confined;
}

async function showFileInEditor(absolutePath: string): Promise<void> {
  const uri = vscode.Uri.file(absolutePath);
  const options = {
    viewColumn: vscode.ViewColumn.One,
    preview: true,
    preserveFocus: false,
  };
  try {
    await vscode.window.showTextDocument(uri, options);
  } catch {
    await vscode.commands.executeCommand("vscode.open", uri, options);
  }
}

/** Open a listed sync file in the main editor. Falls back to the clone copy. */
export async function openSyncKeyFile(
  syncKey: string,
  context?: vscode.ExtensionContext
): Promise<void> {
  const identity = context ? readRepoIdentity() : undefined;
  const clone =
    context && identity
      ? { clonePath: getSyncClonePath(context), basePath: identity.basePath }
      : undefined;
  const candidates = syncKeyOpenCandidates(syncKey, resolveSyncRoots(), clone);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    try {
      await showFileInEditor(candidate);
      return;
    } catch {
      continue;
    }
  }
  void vscode.window.showWarningMessage(t("historyFileNotFound", { path: syncKey }));
}

