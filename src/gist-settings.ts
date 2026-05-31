import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger, loadSyncState, saveSyncState } from "./diagnostics.js";
import { refreshSidebar } from "./sidebar/index.js";
import { extractGistId } from "./transcripts-export.js";

export function formatGistUrl(gistId: string): string {
  return `https://gist.github.com/${gistId}`;
}

export async function executeChangeGistId(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  const token = await requireToken(context);
  if (!token) {
    return;
  }

  const syncState = await loadSyncState(context);
  const currentGistId = syncState?.gistId;

  const input = await vscode.window.showInputBox({
    prompt: "Enter the Gist URL or ID to use for Cursor Sync",
    placeHolder: "e.g., https://gist.github.com/username/1234567890abcdef",
    value: currentGistId ?? "",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Gist URL or ID cannot be empty";
      }
      if (!extractGistId(value.trim())) {
        return "Invalid Gist URL or ID";
      }
      return undefined;
    },
  });

  if (!input) {
    return;
  }

  const gistId = extractGistId(input.trim());
  if (!gistId) {
    vscode.window.showErrorMessage("Invalid Gist URL or ID.");
    return;
  }

  if (currentGistId === gistId) {
    vscode.window.showInformationMessage("Gist ID unchanged.");
    return;
  }

  const client = new GistClient(token);
  const gistResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Verifying Gist access...",
      cancellable: false,
    },
    () => withRetry(() => client.getGist(gistId))
  );

  if (!gistResult.ok) {
    vscode.window.showErrorMessage(
      `Could not access Gist: ${gistResult.error.message}`
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Change Gist ID failed: ${gistResult.error.message}`
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    currentGistId
      ? `Switch sync target from the current Gist to ${gistId}? Checksums will be cleared; the next pull or push may overwrite local or remote files.`
      : `Use Gist ${gistId} as the sync target? Checksums will start empty until the next sync.`,
    { modal: true },
    "Change"
  );

  if (confirm !== "Change") {
    return;
  }

  const now = new Date().toISOString();
  await saveSyncState(context, {
    lastSyncTimestamp: syncState?.lastSyncTimestamp ?? now,
    lastSyncDirection: syncState?.lastSyncDirection ?? "pull",
    gistId,
    localChecksums: {},
    remoteChecksums: {},
  });

  logger.appendLine(
    `[${new Date().toISOString()}] Gist ID changed to ${gistId}`
  );
  refreshSidebar();
  vscode.window.showInformationMessage(
    `Sync Gist updated. URL: ${formatGistUrl(gistId)}`
  );
}

export async function executeCopyGistUrl(
  context: vscode.ExtensionContext
): Promise<void> {
  const syncState = await loadSyncState(context);
  const gistId = syncState?.gistId;

  if (!gistId) {
    vscode.window.showWarningMessage(
      "No Gist configured yet. Run Cursor Sync: Change Gist ID or sync once after configuring GitHub."
    );
    return;
  }

  await vscode.env.clipboard.writeText(formatGistUrl(gistId));
  vscode.window.showInformationMessage("Gist URL copied to clipboard.");
}
