import * as vscode from "vscode";
import { escapeHtml } from "./sync-tab.js";

export interface SettingsTabValues {
  activateDefault: boolean;
  activateStrict: boolean;
  bridgeWaitResultSeconds: number;
  autoReloadAfterImport: boolean;
  pythonPath: string;
}

export function readSettingsValues(): SettingsTabValues {
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  return {
    activateDefault: cfg.get<boolean>("chatImport.activateDefault", true),
    activateStrict: cfg.get<boolean>("chatImport.activateStrict", false),
    bridgeWaitResultSeconds: cfg.get<number>("chatImport.bridgeWaitResultSeconds", 10),
    autoReloadAfterImport: cfg.get<boolean>("transcripts.autoReloadAfterImport", false),
    pythonPath: cfg.get<string>("chatImport.pythonPath", "python3"),
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
  function checkbox(id: string, label: string, checked: boolean): string {
    return `<div class="settings-row">
      <label class="settings-label">
        <input type="checkbox" id="${id}" data-setting-key="${id}" ${checked ? "checked" : ""} />
        <span>${label}</span>
      </label>
    </div>`;
  }

  return `<div id="settings-pane" class="tab-pane" style="display:none">
  <div class="section">
    <div class="section-header">Chat Import</div>
    <div class="settings-list">
      ${checkbox("chatImport.activateDefault", "Activate chat after import", values.activateDefault)}
      ${checkbox("chatImport.activateStrict", "Strict activation (require confirmed activation)", values.activateStrict)}
      <div class="settings-row">
        <label class="settings-label" for="chatImport.bridgeWaitResultSeconds">Bridge wait (seconds)</label>
        <input type="number" id="chatImport.bridgeWaitResultSeconds" data-setting-key="chatImport.bridgeWaitResultSeconds" value="${values.bridgeWaitResultSeconds}" min="0" max="120" class="settings-input" />
      </div>
      ${checkbox("transcripts.autoReloadAfterImport", "Auto-reload after import", values.autoReloadAfterImport)}
      <div class="settings-row">
        <label class="settings-label" for="chatImport.pythonPath">Python path</label>
        <input type="text" id="chatImport.pythonPath" data-setting-key="chatImport.pythonPath" value="${escapeHtml(values.pythonPath)}" class="settings-input settings-input-text" />
      </div>
    </div>
  </div>
</div>`;
}
