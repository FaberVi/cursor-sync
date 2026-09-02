import * as vscode from "vscode";
import { EXTENSION_LABEL } from "./extension-branding.js";
import { clearToken } from "./auth.js";
import { clearSyncState } from "./diagnostics.js";
import { clearLastRemoteExtensions } from "./extensions.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";

export async function executeReset(context: vscode.ExtensionContext): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    `Are you sure you want to reset ${EXTENSION_LABEL}? This will remove your GitHub token, sync state, and reset extension settings to their defaults.`,
    { modal: true },
    "Reset"
  );

  if (confirmation !== "Reset") {
    return;
  }

  // Clear GitHub Token
  await clearToken(context);

  // Clear Sync State (Gist ID, timestamps, checksums)
  await clearSyncState(context);
  await clearLastRemoteExtensions(context);

  // Reset Configuration Settings
  const config = vscode.workspace.getConfiguration("cursorSync");
  const keys = [
    "enabledPaths",
    "excludeGlobs",
    "schedule.enabled",
    "schedule.interval",
    "schedule.intervalUnit",
    "schedule.intervalMin",
    "destination.type",
    "destination.repo",
    "destination.branch",
    "destination.path",
    "ui.language",
    "maxFileSizeKB",
    "syncProfileName",
    "safeMode"
  ];

  for (const key of keys) {
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
  }

  // Update UI Context
  await vscode.commands.executeCommand("setContext", "cursorSync.configured", false);
  updateStatusBar("unconfigured");
  refreshSidebar();

  vscode.window.showInformationMessage(`${EXTENSION_LABEL} has been fully reset.`);
}
