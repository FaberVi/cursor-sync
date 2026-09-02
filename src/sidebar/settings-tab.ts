import * as vscode from "vscode";
import { escapeHtml } from "./sync-tab.js";
import { resolveScheduleInterval } from "../schedule-interval.js";
import { readDestinationSettings } from "../remote/destination.js";
import { readUiLanguage, t, pullUpdatePolicyLabel, type UiLanguage } from "./i18n.js";

/** Extension settings exposed in the sidebar Settings tab (persisted globally). */
export const SIDEBAR_SETTING_KEYS = [
  "ui.language",
  "schedule.enabled",
  "schedule.interval",
  "schedule.intervalUnit",
  "destination.type",
  "destination.repo",
  "destination.branch",
  "destination.path",
  "chats.syncEnabled",
  "chats.syncOnlyFullBackups",
  "chats.pullUpdates",
  "chats.pullUpdatePolicy",
  "mcp.syncEnabled",
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
const INTERVAL_UNITS = ["seconds", "minutes"] as const;
const DESTINATION_TYPES = ["gist", "repo"] as const;
const UI_LANGUAGES: UiLanguage[] = ["en", "it"];

export function readSettingsValues(): SettingsTabValues {
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  const schedule = resolveScheduleInterval(cfg);
  const dest = readDestinationSettings();
  return {
    "ui.language": readUiLanguage(),
    "schedule.enabled": schedule.enabled,
    "schedule.interval": schedule.displayValue,
    "schedule.intervalUnit": schedule.unit,
    "destination.type": dest.type,
    "destination.repo": dest.repo,
    "destination.branch": dest.branch,
    "destination.path": dest.path,
    "chats.syncEnabled": cfg.get<boolean>("chats.syncEnabled", false),
    "chats.syncOnlyFullBackups": cfg.get<boolean>("chats.syncOnlyFullBackups", false),
    "chats.pullUpdates": cfg.get<boolean>("chats.pullUpdates", false),
    "chats.pullUpdatePolicy": cfg.get<string>("chats.pullUpdatePolicy", "newerWins"),
    "mcp.syncEnabled": cfg.get<boolean>("mcp.syncEnabled", false),
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
  if (!(SIDEBAR_SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Setting key not allowed from sidebar: ${key}`);
  }
  const settingKey = key as SidebarSettingKey;
  const cfg = vscode.workspace.getConfiguration("cursorSync");

  let next: boolean | number | string = value as boolean | number | string;
  switch (settingKey) {
    case "ui.language":
      if (value !== "en" && value !== "it") {
        throw new Error("ui.language must be en or it");
      }
      next = value;
      break;
    case "schedule.enabled":
    case "chats.syncEnabled":
    case "mcp.syncEnabled":
    case "chats.syncOnlyFullBackups":
    case "chats.pullUpdates":
    case "chatImport.activateDefault":
    case "chatImport.activateStrict":
    case "chatImport.useProtobufHydration":
    case "chatImport.useIdeHydration":
    case "chatImport.strictDiskGates":
    case "transcripts.autoReloadAfterImport":
      if (typeof value !== "boolean") {
        throw new Error(`${settingKey} must be a boolean`);
      }
      next = value;
      break;
    case "schedule.interval":
    case "chatImport.bridgeWaitResultSeconds":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${settingKey} must be a non-negative number`);
      }
      next = value;
      break;
    case "schedule.intervalUnit":
      if (value !== "seconds" && value !== "minutes") {
        throw new Error("schedule.intervalUnit must be seconds or minutes");
      }
      next = value;
      break;
    case "destination.type":
      if (value !== "gist" && value !== "repo") {
        throw new Error("destination.type must be gist or repo");
      }
      next = value;
      break;
    case "destination.repo":
    case "destination.branch":
    case "destination.path":
      if (typeof value !== "string") {
        throw new Error(`${settingKey} must be a string`);
      }
      next = value;
      if (settingKey === "destination.path") {
        const { normalizeBasePath } = await import("../remote/destination.js");
        next = normalizeBasePath(value);
      }
      break;
    case "chatImport.pythonPath":
      return;
    case "chats.pullUpdatePolicy":
      if (
        value !== "skip" &&
        value !== "remoteWins" &&
        value !== "newerWins" &&
        value !== "ask"
      ) {
        throw new Error("chats.pullUpdatePolicy must be skip|remoteWins|newerWins|ask");
      }
      next = value;
      break;
    default: {
      const _exhaustive: never = settingKey;
      throw new Error(`Unhandled setting key: ${_exhaustive}`);
    }
  }

  await cfg.update(settingKey, next, vscode.ConfigurationTarget.Global);
}

export function renderSettingsPane(values: SettingsTabValues): string {
  function checkbox(id: SidebarSettingKey, label: string, checked: boolean): string {
    return `<div class="settings-row settings-row-check">
      <label class="settings-label">
        <input type="checkbox" id="${id}" data-setting-key="${id}" ${checked ? "checked" : ""} />
        <span>${escapeHtml(label)}</span>
      </label>
    </div>`;
  }

  const destType = String(values["destination.type"]);
  const repoFieldsHidden = destType === "repo" ? "" : " style=\"display:none\"";
  const lang = String(values["ui.language"]) as UiLanguage;

  return `<div id="settings-pane" class="tab-pane" style="display:none">
  <div class="section">
    <div class="section-header">${escapeHtml(t("appearance"))}</div>
    <div class="settings-list">
      <div class="settings-row settings-row-field">
        <label class="settings-label" for="ui.language">${escapeHtml(t("language"))}</label>
        <select id="ui.language" data-setting-key="ui.language" class="settings-input settings-input-text">
          ${UI_LANGUAGES.map(
            (opt) =>
              `<option value="${opt}"${lang === opt ? " selected" : ""}>${escapeHtml(
                opt === "it" ? t("languageIt") : t("languageEn")
              )}</option>`
          ).join("")}
        </select>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="section-header">${escapeHtml(t("autoSync"))}</div>
    <div class="settings-list">
      ${checkbox("schedule.enabled", t("enablePeriodicAutoSync"), Boolean(values["schedule.enabled"]))}
      <div class="settings-row settings-row-field settings-row-inline">
        <label class="settings-label" for="schedule.interval">${escapeHtml(t("interval"))}</label>
        <div class="settings-controls">
          <input type="number" id="schedule.interval" data-setting-key="schedule.interval" value="${values["schedule.interval"]}" min="1" class="settings-input" />
          <select id="schedule.intervalUnit" data-setting-key="schedule.intervalUnit" class="settings-input settings-input-text">
            ${INTERVAL_UNITS.map(
              (opt) =>
                `<option value="${opt}"${values["schedule.intervalUnit"] === opt ? " selected" : ""}>${escapeHtml(
                  opt === "seconds" ? t("seconds") : t("minutes")
                )}</option>`
            ).join("")}
          </select>
        </div>
      </div>
      <div class="settings-hint">${escapeHtml(t("minIntervalHint"))}</div>
    </div>
  </div>
  <div class="section">
    <div class="section-header">${escapeHtml(t("destination"))}</div>
    <div class="settings-list">
      <div class="settings-row settings-row-field">
        <label class="settings-label" for="destination.type">${escapeHtml(t("remoteType"))}</label>
        <select id="destination.type" data-setting-key="destination.type" class="settings-input settings-input-text">
          ${DESTINATION_TYPES.map(
            (opt) =>
              `<option value="${opt}"${destType === opt ? " selected" : ""}>${escapeHtml(
                opt === "gist" ? t("githubGist") : t("githubRepository")
              )}</option>`
          ).join("")}
        </select>
      </div>
      <div id="destination-repo-fields"${repoFieldsHidden}>
        <div class="settings-row settings-row-field">
          <label class="settings-label" for="destination.repo">${escapeHtml(t("repositoryOwnerName"))}</label>
          <input type="text" id="destination.repo" data-setting-key="destination.repo" value="${escapeHtml(String(values["destination.repo"]))}" class="settings-input settings-input-text settings-input-wide" placeholder="owner/repo" />
        </div>
        <div class="settings-row settings-row-field">
          <label class="settings-label" for="destination.branch">${escapeHtml(t("branch"))}</label>
          <input type="text" id="destination.branch" data-setting-key="destination.branch" value="${escapeHtml(String(values["destination.branch"]))}" class="settings-input settings-input-text" />
        </div>
        <div class="settings-row settings-row-field">
          <label class="settings-label" for="destination.path">${escapeHtml(t("pathInRepo"))}</label>
          <input type="text" id="destination.path" data-setting-key="destination.path" value="${escapeHtml(String(values["destination.path"]))}" class="settings-input settings-input-text settings-input-wide" />
        </div>
      </div>
      <button type="button" class="configure-btn settings-connect-btn" data-command="configure" title="${escapeHtml(
        destType === "repo" ? t("connectRepoHint") : t("connectGistHint")
      )}">
        <span class="codicon codicon-github-alt"></span>
        ${escapeHtml(destType === "repo" ? t("connectRepository") : t("connectGithub"))}
      </button>
      <div class="settings-hint">${escapeHtml(
        destType === "repo" ? t("connectRepoHint") : t("connectGistHint")
      )}</div>
    </div>
  </div>
  <div class="section">
    <div class="section-header">${escapeHtml(t("mcpSync"))}</div>
    <div class="settings-list">
      ${checkbox("mcp.syncEnabled", t("includeMcp"), Boolean(values["mcp.syncEnabled"]))}
      <div class="settings-hint">${escapeHtml(t("mcpSyncHint"))}</div>
    </div>
  </div>
  <div class="section">
    <div class="section-header">${escapeHtml(t("chatSync"))}</div>
    <div class="settings-list">
      ${checkbox("chats.syncEnabled", t("includeChats"), Boolean(values["chats.syncEnabled"]))}
      ${checkbox("chats.syncOnlyFullBackups", t("syncOnlyFullBackups"), Boolean(values["chats.syncOnlyFullBackups"]))}
      ${checkbox("chats.pullUpdates", t("pullUpdates"), Boolean(values["chats.pullUpdates"]))}
      <div class="settings-row settings-row-field">
        <label class="settings-label" for="chats.pullUpdatePolicy">${escapeHtml(t("pullUpdatePolicy"))}</label>
        <select id="chats.pullUpdatePolicy" data-setting-key="chats.pullUpdatePolicy" class="settings-input settings-input-text">
          ${PULL_POLICY_OPTIONS.map(
            (opt) =>
              `<option value="${opt}"${values["chats.pullUpdatePolicy"] === opt ? " selected" : ""}>${escapeHtml(pullUpdatePolicyLabel(opt))}</option>`
          ).join("")}
        </select>
      </div>
      <div class="settings-hint">${escapeHtml(t("chatSyncHint"))}</div>
    </div>
  </div>
  <div class="section">
    <div class="section-header">${escapeHtml(t("chatImport"))}</div>
    <div class="settings-list">
      ${checkbox("chatImport.activateDefault", t("activateAfterImport"), Boolean(values["chatImport.activateDefault"]))}
      ${checkbox("chatImport.activateStrict", t("strictActivation"), Boolean(values["chatImport.activateStrict"]))}
      ${checkbox("chatImport.useProtobufHydration", t("protobufHydration"), Boolean(values["chatImport.useProtobufHydration"]))}
      ${checkbox("chatImport.useIdeHydration", t("ideHydration"), Boolean(values["chatImport.useIdeHydration"]))}
      ${checkbox("chatImport.strictDiskGates", t("strictDiskGates"), Boolean(values["chatImport.strictDiskGates"]))}
      <div class="settings-row settings-row-field">
        <label class="settings-label" for="chatImport.bridgeWaitResultSeconds">${escapeHtml(t("bridgeWait"))}</label>
        <input type="number" id="chatImport.bridgeWaitResultSeconds" data-setting-key="chatImport.bridgeWaitResultSeconds" value="${values["chatImport.bridgeWaitResultSeconds"]}" min="0" max="120" class="settings-input" />
      </div>
      ${checkbox("transcripts.autoReloadAfterImport", t("autoReloadAfterImport"), Boolean(values["transcripts.autoReloadAfterImport"]))}
      <div class="settings-row settings-row-field">
        <label class="settings-label" for="chatImport.pythonPath">${escapeHtml(t("pythonPath"))}</label>
        <input type="text" id="chatImport.pythonPath" data-setting-key="chatImport.pythonPath" value="${escapeHtml(String(values["chatImport.pythonPath"]))}" class="settings-input settings-input-text" readonly disabled />
      </div>
      <div class="settings-hint">${escapeHtml(t("pythonPathHint"))}</div>
    </div>
  </div>
</div>`;
}
