import * as vscode from "vscode";
import { EN } from "./i18n-en.js";
import { IT } from "./i18n-it.js";

export type UiLanguage = "en" | "it";

export type MessageKey =
  | "tabSync"
  | "tabChats"
  | "tabSettings"
  | "synced"
  | "notSynced"
  | "syncing"
  | "syncError"
  | "never"
  | "push"
  | "pull"
  | "resetToRemote"
  | "resetToRemoteHint"
  | "openSyncClone"
  | "openSyncCloneHint"
  | "pullReplaceConfirm"
  | "pullReplaceConfirmFilesOnly"
  | "pullReplaceConfirmChatsOnly"
  | "syncNowHint"
  | "pushHint"
  | "pullHint"
  | "openCursorFolder"
  | "openCursorFolderHint"
  | "openCursorFolderPick"
  | "openCursorFolderDotCursor"
  | "openCursorFolderUser"
  | "stopSyncHint"
  | "tabSyncHint"
  | "tabChatsHint"
  | "tabSettingsHint"
  | "clearHint"
  | "openChatHint"
  | "revealFilesHint"
  | "importBundleHint"
  | "prevHint"
  | "nextHint"
  | "couldNotResolveChatFolder"
  | "filesTracked"
  | "fileTracked"
  | "notLinked"
  | "chatsInBackup"
  | "chatsLocalNotInBackup"
  | "chatsNotIncluded"
  | "syncNow"
  | "actions"
  | "export"
  | "import"
  | "history"
  | "noHistory"
  | "prev"
  | "next"
  | "historyShowFiles"
  | "historyNoFiles"
  | "historyFiles"
  | "historyFilesRatio"
  | "historyFilesCount"
  | "historyFilesCountRatio"
  | "historyFilesPlaceholder"
  | "historyFileNotFound"
  | "auto"
  | "autoSync"
  | "enablePeriodicAutoSync"
  | "interval"
  | "seconds"
  | "minutes"
  | "minIntervalHint"
  | "destination"
  | "githubRepository"
  | "repositoryOwnerName"
  | "branch"
  | "pathInRepo"
  | "connectRepository"
  | "connectRepoHint"
  | "language"
  | "languageEn"
  | "languageIt"
  | "appearance"
  | "mcpSync"
  | "includeMcp"
  | "mcpSyncHint"
  | "chatSync"
  | "includeChats"
  | "syncOnlyFullBackups"
  | "pullUpdates"
  | "pullUpdatePolicy"
  | "pullPolicySkip"
  | "pullPolicyRemoteWins"
  | "pullPolicyNewerWins"
  | "pullPolicyAsk"
  | "chatSyncHint"
  | "chatImport"
  | "activateAfterImport"
  | "strictActivation"
  | "protobufHydration"
  | "ideHydration"
  | "strictDiskGates"
  | "bridgeWait"
  | "autoReloadAfterImport"
  | "pythonPath"
  | "pythonPathHint"
  | "activeOperation"
  | "localChatsByProject"
  | "importsAndBundles"
  | "bundleFiles"
  | "clear"
  | "loading"
  | "noLocalChats"
  | "groupLoadEmpty"
  | "noImportHistory"
  | "noBundleFiles"
  | "chatsCount"
  | "timeJustNow"
  | "timeMinutesAgo"
  | "timeHoursAgo"
  | "timeDaysAgo"
  | "open"
  | "opening"
  | "files"
  | "unknownProject"
  | "invalidSetting"
  | "phasePrefix"
  | "textOnlyL4Badge"
  | "textOnlyL4Detail"
  | "warnCount"
  | "toolBubblesCount"
  | "transcriptsWritten"
  | "syncFailed"
  | "destBadgeRepo"
  | "extensionVersionTitle"
  | "invalidConversationId"
  | "invalidWorkspaceKey"
  | "invalidProjectKey"
  | "openWorkspaceFirst"
  | "missingConversationIdOpen"
  | "missingConversationIdFiles"
  | "couldNotOpenChat"
  | "couldNotRevealFiles"
  | "historyEntryNotFound"
  | "historyNoFileListRecorded"
  | "historyClearHint"
  | "historyDeleteHint"
  | "historyDelete"
  | "historyDeleteConfirm"
  | "historyClearAllConfirm"
  | "openAnyway"
  | "cancel"
  | "stopSync"
  | "openedTranscriptReload"
  | "couldNotOpenChatDisk"
  | "revealHeaderOnlyAgentTranscripts"
  | "revealNoTranscriptProject"
  | "revealComposerOnlyAgentTranscripts"
  | "revealComposerOnlyProject"
  | "revealNoDiskFolder"
  | "tierFull"
  | "tierResume"
  | "tierPartial"
  | "tierArchive"
  | "tierWarningArchive"
  | "tierWarningPartial"
  | "openTierWarningArchive"
  | "openTierWarningPartial"
  | "backupDetailJsonl"
  | "backupDetailNoJsonl"
  | "backupDetailStore"
  | "backupDetailNoStore"
  | "backupDetailSubagentJsonl"
  | "backupDetailDiskKvRows"
  | "backupDetailToolBubbles";

const CATALOG: Record<UiLanguage, Record<MessageKey, string>> = {
  en: EN,
  it: IT,
};

const PULL_POLICY_KEYS = {
  skip: "pullPolicySkip",
  remoteWins: "pullPolicyRemoteWins",
  newerWins: "pullPolicyNewerWins",
  ask: "pullPolicyAsk",
} as const satisfies Record<string, MessageKey>;

const TIER_KEYS = {
  full: "tierFull",
  resume: "tierResume",
  partial: "tierPartial",
  archive: "tierArchive",
} as const satisfies Record<string, MessageKey>;

export function readUiLanguage(): UiLanguage {
  try {
    const raw = vscode.workspace
      ?.getConfiguration("cursorSync")
      ?.get<string>("ui.language");
    if (raw === "it" || raw === "en") {
      return raw;
    }
    const env = vscode.env?.language?.toLowerCase() ?? "";
    return env.startsWith("it") ? "it" : "en";
  } catch {
    return "en";
  }
}

export function t(
  key: MessageKey,
  vars?: Record<string, string | number>,
  lang: UiLanguage = readUiLanguage()
): string {
  let text = CATALOG[lang][key] ?? EN[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
    }
  }
  return text;
}

export function formatRelativeTime(
  isoString: string,
  lang: UiLanguage = readUiLanguage()
): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0) {
    return t("timeJustNow", undefined, lang);
  }
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return t("timeJustNow", undefined, lang);
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t("timeMinutesAgo", { n: minutes }, lang);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("timeHoursAgo", { n: hours }, lang);
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return t("timeDaysAgo", { n: days }, lang);
  }
  return new Date(isoString).toLocaleDateString(lang === "it" ? "it-IT" : "en-US");
}

export function pullUpdatePolicyLabel(
  policy: string,
  lang: UiLanguage = readUiLanguage()
): string {
  const key = PULL_POLICY_KEYS[policy as keyof typeof PULL_POLICY_KEYS];
  return key ? t(key, undefined, lang) : policy;
}

export function localizedBackupTierLabel(
  tier: "full" | "resume" | "partial" | "archive",
  lang: UiLanguage = readUiLanguage()
): string {
  return t(TIER_KEYS[tier], undefined, lang);
}

/** Strings the webview JS needs for dynamic UI. */
export function webviewI18nPayload(lang: UiLanguage = readUiLanguage()): Record<string, string> {
  const keys: MessageKey[] = [
    "loading",
    "noLocalChats",
    "groupLoadEmpty",
    "noImportHistory",
    "noBundleFiles",
    "connectRepository",
    "connectRepoHint",
    "chatsCount",
    "prev",
    "next",
    "clear",
    "syncNow",
    "push",
    "pull",
    "resetToRemote",
    "resetToRemoteHint",
    "openSyncClone",
    "openSyncCloneHint",
    "syncNowHint",
    "pushHint",
    "pullHint",
    "stopSyncHint",
    "openChatHint",
    "revealFilesHint",
    "importBundleHint",
    "prevHint",
    "nextHint",
    "stopSync",
    "import",
    "open",
    "opening",
    "files",
    "unknownProject",
    "invalidSetting",
    "phasePrefix",
    "textOnlyL4Badge",
    "textOnlyL4Detail",
    "warnCount",
    "toolBubblesCount",
    "transcriptsWritten",
    "timeJustNow",
    "timeMinutesAgo",
    "timeHoursAgo",
    "timeDaysAgo",
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    out[key] = t(key, undefined, lang);
  }
  return out;
}
