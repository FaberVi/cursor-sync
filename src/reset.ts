import * as vscode from "vscode";
import { EXTENSION_LABEL } from "./extension-branding.js";
import { clearToken } from "./auth.js";
import { clearSyncState } from "./diagnostics.js";
import { clearLastRemoteExtensions } from "./extensions.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { removeSyncClone } from "./sync-clone.js";
import { enterSyncLock, leaveSyncLock } from "./sync-lock.js";

export async function executeReset(context: vscode.ExtensionContext): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    `Are you sure you want to reset ${EXTENSION_LABEL}? This will remove your GitHub token, sync state, local git clone, and reset extension settings to their defaults.`,
    { modal: true },
    "Reset"
  );

  if (confirmation !== "Reset") {
    return;
  }

  const lockHold = enterSyncLock();
  if (lockHold === "busy") {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return;
  }

  try {
    await clearToken(context);
    await clearSyncState(context);
    await clearLastRemoteExtensions(context);
    await removeSyncClone(context);

    const config = vscode.workspace.getConfiguration("cursorSync");
    const keys = [
      "enabledPaths",
      "excludeGlobs",
      "schedule.enabled",
      "schedule.interval",
      "schedule.intervalUnit",
      "schedule.intervalMin",
      "destination.repo",
      "destination.branch",
      "destination.path",
      "ui.language",
      "maxFileSizeKB",
      "syncProfileName",
      "chats.encrypt",
      "chats.syncEnabled",
      "chats.syncOnlyFullBackups",
      "chats.pullUpdates",
      "chats.pullUpdatePolicy",
      "chats.maxCollectionSizeKB",
      "mcp.syncEnabled",
      "chatGist.encrypt",
    ];

    for (const key of keys) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }

    await vscode.commands.executeCommand("setContext", "cursorSync.configured", false);
    updateStatusBar("unconfigured");
    refreshSidebar();

    vscode.window.showInformationMessage(`${EXTENSION_LABEL} has been fully reset.`);
  } finally {
    leaveSyncLock(lockHold);
  }
}
