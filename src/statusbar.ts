import * as vscode from "vscode";
import { EXTENSION_LABEL } from "./extension-branding.js";
import { statusWarningPlain, t } from "./sidebar/i18n.js";

let statusBarItem: vscode.StatusBarItem;

export type SyncState =
  | "ok"
  | "syncing"
  | "error"
  | "unconfigured"
  | "behind"
  | "not-synced";

let lastIdleState: SyncState = "unconfigured";
let currentState: SyncState = "unconfigured";

export function getStatusBarState(): SyncState {
  return currentState;
}

export function initializeStatusBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "cursorSync.showStatus";
  context.subscriptions.push(statusBarItem);

  updateStatusBar("unconfigured");
  statusBarItem.show();
}

export function updateStatusBar(
  state: SyncState,
  lastSync?: Date,
  tooltipOverride?: string
): void {
  if (!statusBarItem) {
    return;
  }

  currentState = state;
  if (state !== "syncing") {
    lastIdleState = state;
  }

  let icon = "";
  let text = EXTENSION_LABEL;
  let tooltip = `${EXTENSION_LABEL} Status`;

  switch (state) {
    case "ok":
      icon = "$(check)";
      text = "Sync: OK";
      tooltip = lastSync ? `Last synced: ${lastSync.toLocaleString()}` : "Synced successfully";
      break;
    case "syncing":
      icon = "$(sync~spin)";
      text = "Syncing...";
      tooltip = "Click to stop";
      break;
    case "error":
      icon = "$(error)";
      text = "Sync: Error";
      tooltip = "Error during synchronization. Click to view logs.";
      break;
    case "unconfigured":
      icon = "$(gear)";
      text = "Sync: Setup";
      tooltip = `${EXTENSION_LABEL} is not configured. Click to set up.`;
      statusBarItem.command = "cursorSync.configureGithub";
      break;
    case "behind":
      icon = "$(cloud-download)";
      text = `Sync: ${t("behind")}`;
      tooltip = tooltipOverride ?? statusWarningPlain("behind");
      break;
    case "not-synced":
      icon = "$(warning)";
      text = `Sync: ${t("notSynced")}`;
      tooltip = tooltipOverride ?? statusWarningPlain("not-synced");
      break;
  }

  if (state === "syncing") {
    statusBarItem.command = "cursorSync.cancelSync";
  } else if (state === "unconfigured") {
    statusBarItem.command = "cursorSync.configureGithub";
  } else if (state === "behind" || state === "not-synced") {
    statusBarItem.command = "cursorSync.revealSidebar";
  } else {
    statusBarItem.command = "cursorSync.showStatus";
  }

  statusBarItem.text = `${icon} ${text}`;
  statusBarItem.tooltip = tooltip;
}

export function restoreStatusBarAfterCancel(): void {
  const restored = lastIdleState === "syncing" ? "ok" : lastIdleState;
  updateStatusBar(restored);
}

export function showStatusBar(): void {
  statusBarItem?.show();
}

export function hideStatusBar(): void {
  statusBarItem?.hide();
}
