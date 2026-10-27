import type * as vscode from "vscode";
import { refreshSidebar } from "./sidebar/index.js";
import { probeRemoteAhead } from "./remote-ahead.js";

/** Re-read local/remote sync indicators and refresh the sidebar UI (no push/pull). */
export async function executeRefreshSyncStatus(
  context: vscode.ExtensionContext
): Promise<void> {
  refreshSidebar();
  await probeRemoteAhead(context);
}
