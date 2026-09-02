import * as vscode from "vscode";
import { loadSyncState, loadSyncHistory } from "../diagnostics.js";
import {
  countLocalDiscoveredChats,
  isChatSyncEnabled,
  fetchRemoteChatCollection,
} from "../chat-sync.js";
import { requireToken } from "../auth.js";
import {
  hasRemoteDestination,
  remoteUrlForState,
  syncStateIdentity,
  readDestinationSettings,
  normalizeSyncStateDestination,
} from "../remote/index.js";
import { readExtensionVersion } from "../extension-version.js";
import type { SyncTabState } from "./sync-tab.js";
import { renderSyncPane } from "./sync-tab.js";
import { renderSettingsPane, readSettingsValues } from "./settings-tab.js";
import { t, webviewI18nPayload } from "./i18n.js";
import { escapeHtml } from "./sync-tab.js";
import { getPendingConflicts, getResolutionForKey } from "../conflicts.js";

function pendingConflictsForTab(): NonNullable<SyncTabState["pendingConflicts"]> {
  return getPendingConflicts().map((c) => ({
    relativeSyncKey: c.relativeSyncKey,
    resolution: getResolutionForKey(c.relativeSyncKey),
  }));
}

export interface BuildSyncTabStateOptions {
  /** Skip filesystem chat discovery and remote gist/repo fetch (slow). */
  deferHeavyMetrics?: boolean;
}

function extensionVersionForContext(context: vscode.ExtensionContext): string {
  return readExtensionVersion(context);
}

function buildSyncTabStateShell(context: vscode.ExtensionContext): SyncTabState {
  const destSettings = readDestinationSettings();
  return {
    status: "syncing",
    lastSyncTime: undefined,
    lastSyncDirection: undefined,
    fileCount: 0,
    gistId: undefined,
    remoteLabel: undefined,
    remoteUrl: undefined,
    destinationKind: destSettings.type,
    extensionVersion: extensionVersionForContext(context),
    history: [],
    chatsSyncEnabled: isChatSyncEnabled(),
    localChatCount: 0,
    remoteChatCount: undefined,
    chatCountsLoading: true,
    pendingConflicts: pendingConflictsForTab(),
  };
}

export async function buildSyncTabState(
  context: vscode.ExtensionContext,
  options: BuildSyncTabStateOptions = {}
): Promise<SyncTabState> {
  const deferHeavyMetrics = options.deferHeavyMetrics === true;
  const syncState = await loadSyncState(context);
  const history = await loadSyncHistory(context);
  const chatsSyncEnabled = isChatSyncEnabled();
  const extensionVersion = extensionVersionForContext(context);
  const destSettings = readDestinationSettings();
  const destinationKind =
    (syncState
      ? normalizeSyncStateDestination(syncState, destSettings).destination?.type
      : undefined) ?? destSettings.type;
  let localChatCount = 0;
  let remoteChatCount: number | undefined;
  let chatCountsLoading = deferHeavyMetrics;

  if (!deferHeavyMetrics) {
    localChatCount = await countLocalDiscoveredChats();
    if (chatsSyncEnabled && hasRemoteDestination(syncState)) {
      const token = await requireToken(context);
      if (token && syncState) {
        try {
          const remote = await fetchRemoteChatCollection(
            context,
            syncState.gistId || syncStateIdentity(syncState),
            token
          );
          remoteChatCount = remote?.length ?? 0;
        } catch {
          remoteChatCount = undefined;
        }
      }
    }
  }

  if (!syncState) {
    return {
      status: "not-synced",
      lastSyncTime: undefined,
      lastSyncDirection: undefined,
      fileCount: 0,
      gistId: undefined,
      remoteLabel: undefined,
      remoteUrl: undefined,
      destinationKind,
      extensionVersion,
      history,
      chatsSyncEnabled,
      localChatCount,
      remoteChatCount,
      chatCountsLoading,
      pendingConflicts: pendingConflictsForTab(),
    };
  }

  return {
    status: "synced",
    lastSyncTime: syncState.lastSyncTimestamp,
    lastSyncDirection: syncState.lastSyncDirection,
    fileCount: Object.keys(syncState.localChecksums).length,
    gistId: syncState.gistId,
    remoteLabel: syncStateIdentity(syncState) || undefined,
    remoteUrl: remoteUrlForState(syncState),
    destinationKind,
    extensionVersion,
    history,
    chatsSyncEnabled,
    localChatCount,
    remoteChatCount,
    chatCountsLoading,
    pendingConflicts: pendingConflictsForTab(),
  };
}

function assembleSidebarDocument(params: {
  webview: vscode.Webview;
  context: vscode.ExtensionContext;
  syncPaneHtml: string;
  settingsPaneHtml: string;
  htmlLang: string;
}): string {
  const { webview, context, syncPaneHtml, settingsPaneHtml, htmlLang } = params;
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "resources", "sidebar", "webview.js")
  );
  const sidebarAsset = (name: string) =>
    webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "resources", "sidebar", name)
    );
  const shellCssUri = sidebarAsset("webview-shell.css");
  const chatsCssUri = sidebarAsset("webview-chats.css");
  const settingsCssUri = sidebarAsset("webview-settings.css");
  const coreJsUri = sidebarAsset("webview-core.js");
  const progressJsUri = sidebarAsset("webview-progress.js");
  const chatsJsUri = sidebarAsset("webview-chats.js");
  const handlersJsUri = sidebarAsset("webview-handlers.js");
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${shellCssUri}">
  <link rel="stylesheet" href="${chatsCssUri}">
  <link rel="stylesheet" href="${settingsCssUri}">
</head>
<body>
  <script type="application/json" id="ui-i18n">${JSON.stringify(webviewI18nPayload()).replace(/</g, "\\u003c")}</script>
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="sync-pane">${escapeHtml(t("tabSync"))}</button>
    <button class="tab-btn" data-tab="chats-pane">${escapeHtml(t("tabChats"))}</button>
    <button class="tab-btn" data-tab="settings-pane">${escapeHtml(t("tabSettings"))}</button>
  </div>

  ${syncPaneHtml}

  <div id="chats-pane" class="tab-pane" style="display:none">
    <div class="chats-section" id="chats-active-section" style="display:none">
      <div class="chats-section-header">${escapeHtml(t("activeOperation"))}</div>
      <div id="chats-active"></div>
    </div>

    <div class="chats-section">
      <div class="chats-section-header">
        <span>${escapeHtml(t("localChatsByProject"))}</span>
      </div>
      <div id="chats-grouped" class="chats-grouped">
        <div class="empty-state">${escapeHtml(t("loading"))}</div>
      </div>
    </div>

    <div class="chats-section">
      <div class="chats-section-header">
        <span>${escapeHtml(t("importsAndBundles"))}</span>
        <button class="clear-btn" data-command="chats:clearHistory">${escapeHtml(t("clear"))}</button>
      </div>
      <div id="chats-imports" class="chats-list">
        <div class="empty-state">${escapeHtml(t("loading"))}</div>
      </div>
    </div>

    <div class="chats-section">
      <div class="chats-section-header">${escapeHtml(t("bundleFiles"))}</div>
      <div id="chats-bundles" class="chats-list">
        <div class="empty-state">${escapeHtml(t("loading"))}</div>
      </div>
    </div>
  </div>

  ${settingsPaneHtml}

  <script src="${coreJsUri}"></script>
  <script src="${progressJsUri}"></script>
  <script src="${chatsJsUri}"></script>
  <script src="${handlersJsUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

export function renderSidebarShellHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): string {
  const settingsValues = readSettingsValues();
  return assembleSidebarDocument({
    webview,
    context,
    syncPaneHtml: renderSyncPane(buildSyncTabStateShell(context)),
    settingsPaneHtml: renderSettingsPane(settingsValues),
    htmlLang: settingsValues["ui.language"] === "it" ? "it" : "en",
  });
}

export async function renderSyncPaneHtml(
  context: vscode.ExtensionContext,
  options: BuildSyncTabStateOptions = {}
): Promise<string> {
  const state = await buildSyncTabState(context, options);
  return renderSyncPane(state);
}

export async function renderSidebarHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): Promise<string> {
  const state = await buildSyncTabState(context, { deferHeavyMetrics: true });
  const settingsValues = readSettingsValues();
  return assembleSidebarDocument({
    webview,
    context,
    syncPaneHtml: renderSyncPane(state),
    settingsPaneHtml: renderSettingsPane(settingsValues),
    htmlLang: settingsValues["ui.language"] === "it" ? "it" : "en",
  });
}
