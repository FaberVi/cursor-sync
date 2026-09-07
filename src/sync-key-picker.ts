import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { t } from "./sidebar/i18n.js";
import { resolveSyncRoots } from "./paths.js";
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

/** Open the Cursor-side file for a sync key; warn if it is missing. */
export async function openSyncKeyFile(syncKey: string): Promise<void> {
  const roots = resolveSyncRoots();
  const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
  if (!absolutePath) {
    void vscode.window.showWarningMessage(
      t("historyFileNotFound", { path: syncKey })
    );
    return;
  }
  try {
    await fs.access(absolutePath);
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(absolutePath));
  } catch {
    void vscode.window.showWarningMessage(
      t("historyFileNotFound", { path: syncKey })
    );
  }
}

/**
 * QuickPick of sync keys. Selecting a row opens the Cursor-side file when it exists.
 */
export async function showSyncKeyQuickPick(options: {
  entries: readonly SyncKeyPreviewEntry[];
  title: string;
  placeHolder: string;
  emptyMessage: string;
}): Promise<void> {
  if (options.entries.length === 0) {
    void vscode.window.showInformationMessage(options.emptyMessage);
    return;
  }
  const roots = resolveSyncRoots();
  const picked = await vscode.window.showQuickPick(
    options.entries.map((entry) => {
      const absolutePath = syncKeyToAbsolutePath(entry.syncKey, roots);
      const change = syncKeyChangeLabel(entry.change);
      return {
        label: entry.syncKey,
        description: change ?? absolutePath ?? entry.syncKey,
        detail: change && absolutePath ? absolutePath : undefined,
        syncKey: entry.syncKey,
      };
    }),
    {
      title: options.title,
      placeHolder: options.placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  if (!picked) {
    return;
  }
  await openSyncKeyFile(picked.syncKey);
}
