import * as vscode from "vscode";
import { escapeHtml } from "./sync-tab.js";

/** Extension settings exposed in the sidebar Settings tab (persisted globally). */
export const SIDEBAR_SETTING_KEYS = [
  "chats.syncEnabled",
  "chats.syncOnlyFullBackups",
  "chats.pullUpdates",
  "chats.pullUpdatePolicy",
  "chatImport.activateDefault",
  "chatImport.activateStrict",
  "chatImport.useProtobufHydration",
  "chatImport.useIdeHydration",
  "chatImport.strictDiskGates",
  "chatImport.bridgeWaitResultSeconds",
  "transcripts.autoReloadAfterImport",
  "chatImport.pythonPath",
] as const;

export type SidebarSettingKey = (typeof SIDEBAR_SETTING_KEYS)[number];

export type SettingsTabValues = Record<SidebarSettingKey, boolean | number | string>;

const PULL_POLICY_OPTIONS = ["skip", "remoteWins", "newerWins", "ask"] as const;

export function readSettingsValues(): SettingsTabValues {
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  return {
    "chats.syncEnabled": cfg.get<boolean>("chats.syncEnabled", true),
    "chats.syncOnlyFullBackups": cfg.get<boolean>("chats.syncOnlyFullBackups", false),
    "chats.pullUpdates": cfg.get<boolean>("chats.pullUpdates", false),
    "chats.pullUpdatePolicy": cfg.get<string>("chats.pullUpdatePolicy", "newerWins"),
    "chatImport.activateDefault": cfg.get<boolean>("chatImport.activateDefault", false),
    "chatImport.activateStrict": cfg.get<boolean>("chatImport.activateStrict", false),
    "chatImport.useProtobufHydration": cfg.get<boolean>("chatImport.useProtobufHydration", true),
    "chatImport.useIdeHydration": cfg.get<boolean>("chatImport.useIdeHydration", false),
    "chatImport.strictDiskGates": cfg.get<boolean>("chatImport.strictDiskGates", false),
    "chatImport.bridgeWaitResultSeconds": cfg.get<number>(
      "chatImport.bridgeWaitResultSeconds",
      0
    ),
    "transcripts.autoReloadAfterImport": cfg.get<boolean>(
      "transcripts.autoReloadAfterImport",
      false
    ),
    "chatImport.pythonPath": cfg.get<string>("chatImport.pythonPath", ""),
  };
}

export async function updateSettingValue(
  key: string,
  value: unknown
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  await cfg.update(key, value, vscode.ConfigurationTarget.Global);
}

export function renderSettingsPane(values: SettingsTabValues): string {
  function checkbox(id: SidebarSettingKey, label: string, checked: boolean): string {
    return `<div class="settings-row">
      <label class="settings-label">
        <input type="checkbox" id="${id}" data-setting-key="${id}" ${checked ? "checked" : ""} />
        <span>${label}</span>
      </label>
    </div>`;
  }

  return `<div id="settings-pane" class="tab-pane" style="display:none">
  <div class="section">
    <div class="section-header">Chat Sync</div>
    <div class="settings-list">
      ${checkbox("chats.syncEnabled", "Include chats in Sync Now / Push / Pull", Boolean(values["chats.syncEnabled"]))}
      ${checkbox("chats.syncOnlyFullBackups", "Sync only resumable chats (skip transcript-only)", Boolean(values["chats.syncOnlyFullBackups"]))}
      ${checkbox("chats.pullUpdates", "Update local chats from remote on pull", Boolean(values["chats.pullUpdates"]))}
      <div class="settings-row">
        <label class="settings-label" for="chats.pullUpdatePolicy">Pull update policy</label>
        <select id="chats.pullUpdatePolicy" data-setting-key="chats.pullUpdatePolicy" class="settings-input settings-input-text">
          ${PULL_POLICY_OPTIONS.map(
            (opt) =>
              `<option value="${opt}"${values["chats.pullUpdatePolicy"] === opt ? " selected" : ""}>${opt}</option>`
          ).join("")}
        </select>
      </div>
      <div class="settings-hint">Pull imports new chats by default. Enable pull updates to refresh chats already on this machine.</div>
    </div>
  </div>
  <div class="section">
    <div class="section-header">Chat Import</div>
    <div class="settings-list">
      ${checkbox("chatImport.activateDefault", "Activate chat after import", Boolean(values["chatImport.activateDefault"]))}
      ${checkbox("chatImport.activateStrict", "Strict activation (require confirmed activation)", Boolean(values["chatImport.activateStrict"]))}
      ${checkbox("chatImport.useProtobufHydration", "Protobuf hydration from bundle diskKv (recommended)", Boolean(values["chatImport.useProtobufHydration"]))}
      ${checkbox("chatImport.useIdeHydration", "IDE-only hydration (skip protobuf path)", Boolean(values["chatImport.useIdeHydration"]))}
      ${checkbox("chatImport.strictDiskGates", "Fail import if hydration leaves empty conversation", Boolean(values["chatImport.strictDiskGates"]))}
      <div class="settings-row">
        <label class="settings-label" for="chatImport.bridgeWaitResultSeconds">Bridge wait (seconds)</label>
        <input type="number" id="chatImport.bridgeWaitResultSeconds" data-setting-key="chatImport.bridgeWaitResultSeconds" value="${values["chatImport.bridgeWaitResultSeconds"]}" min="0" max="120" class="settings-input" />
      </div>
      ${checkbox("transcripts.autoReloadAfterImport", "Auto-reload after import", Boolean(values["transcripts.autoReloadAfterImport"]))}
      <div class="settings-row">
        <label class="settings-label" for="chatImport.pythonPath">Python path</label>
        <input type="text" id="chatImport.pythonPath" data-setting-key="chatImport.pythonPath" value="${escapeHtml(String(values["chatImport.pythonPath"]))}" class="settings-input settings-input-text" />
      </div>
    </div>
  </div>
</div>`;
}
