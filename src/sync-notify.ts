import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { refreshSidebar } from "./sidebar/index.js";

/**
 * Success and no-op outcomes belong in the Sync tab (history + status).
 * Toast only when the user must act or the run failed.
 */
export function notifySyncQuiet(message: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] ${message}`);
  refreshSidebar();
}

export function notifySyncError(message: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] ${message}`);
  refreshSidebar();
  void vscode.window.showErrorMessage(message);
}

export function notifySyncActionRequired(
  message: string,
  ...items: string[]
): Thenable<string | undefined> {
  getLogger().appendLine(`[${new Date().toISOString()}] ${message}`);
  refreshSidebar();
  return vscode.window.showWarningMessage(message, ...items);
}
