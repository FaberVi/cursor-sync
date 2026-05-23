import * as vscode from "vscode";

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
        <input type="checkbox" id="${id}" ${checked ? "checked" : ""} onchange="onSettingChange('${id}', this.checked)" />
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
        <input type="number" id="chatImport.bridgeWaitResultSeconds" value="${values.bridgeWaitResultSeconds}" min="0" max="120" class="settings-input" onchange="onSettingChange('chatImport.bridgeWaitResultSeconds', Number(this.value))" />
      </div>
      ${checkbox("transcripts.autoReloadAfterImport", "Auto-reload after import", values.autoReloadAfterImport)}
      <div class="settings-row">
        <label class="settings-label" for="chatImport.pythonPath">Python path</label>
        <input type="text" id="chatImport.pythonPath" value="${values.pythonPath}" class="settings-input settings-input-text" onchange="onSettingChange('chatImport.pythonPath', this.value)" />
      </div>
    </div>
  </div>
</div>`;
}
