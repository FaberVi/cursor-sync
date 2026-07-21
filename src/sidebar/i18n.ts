import * as vscode from "vscode";

export type UiLanguage = "en" | "it";

type MessageKey =
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
  | "auto"
  | "autoSync"
  | "enablePeriodicAutoSync"
  | "interval"
  | "seconds"
  | "minutes"
  | "minIntervalHint"
  | "destination"
  | "remoteType"
  | "githubGist"
  | "githubRepository"
  | "repositoryOwnerName"
  | "branch"
  | "pathInRepo"
  | "connectRepository"
  | "connectGithub"
  | "connectRepoHint"
  | "connectGistHint"
  | "language"
  | "languageEn"
  | "languageIt"
  | "appearance"
  | "chatSync"
  | "includeChats"
  | "syncOnlyFullBackups"
  | "pullUpdates"
  | "pullUpdatePolicy"
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
  | "activeOperation"
  | "localChatsByProject"
  | "importsAndBundles"
  | "clear"
  | "loading"
  | "noLocalChats"
  | "noImportHistory"
  | "chatsCount";

const EN: Record<MessageKey, string> = {
  tabSync: "Sync",
  tabChats: "Chats",
  tabSettings: "Settings",
  synced: "Synced",
  notSynced: "Not Synced",
  syncing: "Syncing...",
  syncError: "Sync Error",
  never: "Never",
  push: "Push",
  pull: "Pull",
  filesTracked: "files tracked",
  fileTracked: "file tracked",
  notLinked: "Not linked",
  chatsInBackup: "Chats in backup: {remote} remote · {local} local",
  chatsLocalNotInBackup: "Chats: {local} local (not yet in backup)",
  chatsNotIncluded: "Chats: not included in sync",
  syncNow: "Sync Now",
  actions: "Actions",
  export: "Export",
  import: "Import",
  history: "History",
  noHistory: "No sync history yet",
  prev: "Prev",
  next: "Next",
  historyShowFiles: "Show files involved in this sync",
  historyNoFiles: "File list not recorded for this entry",
  historyFiles: "{n} files",
  historyFilesRatio: "{changed} / {total} files",
  auto: "auto",
  autoSync: "Auto-sync",
  enablePeriodicAutoSync: "Enable periodic auto-sync",
  interval: "Interval",
  seconds: "seconds",
  minutes: "minutes",
  minIntervalHint: "Minimum interval is 30 seconds.",
  destination: "Destination",
  remoteType: "Remote type",
  githubGist: "GitHub Gist",
  githubRepository: "GitHub repository",
  repositoryOwnerName: "Repository (owner/name)",
  branch: "Branch",
  pathInRepo: "Path in repo",
  connectRepository: "Connect repository",
  connectGithub: "Connect GitHub",
  connectRepoHint:
    "Connect verifies the PAT and repo access. If the repo is missing you can create it (private or public). Format: FaberVi/my-backup-repo.",
  connectGistHint:
    "Saves a PAT with gist scope and discovers an existing Cursor Sync Gist if present.",
  language: "Language",
  languageEn: "English",
  languageIt: "Italiano",
  appearance: "Appearance",
  chatSync: "Chat Sync",
  includeChats: "Include chats in Sync Now / Push / Pull",
  syncOnlyFullBackups: "Sync only resumable chats (skip transcript-only)",
  pullUpdates: "Update local chats from remote on pull",
  pullUpdatePolicy: "Pull update policy",
  chatSyncHint:
    "Pull imports new chats by default. Enable pull updates to refresh chats already on this machine.",
  chatImport: "Chat Import",
  activateAfterImport: "Activate chat after import",
  strictActivation: "Strict activation (require confirmed activation)",
  protobufHydration: "Protobuf hydration from bundle diskKv (recommended)",
  ideHydration: "IDE-only hydration (skip protobuf path)",
  strictDiskGates: "Fail import if hydration leaves empty conversation",
  bridgeWait: "Bridge wait (seconds)",
  autoReloadAfterImport: "Auto-reload after import",
  pythonPath: "Python path",
  activeOperation: "Active Operation",
  localChatsByProject: "Local chats by project",
  importsAndBundles: "Imports & bundles",
  clear: "Clear",
  loading: "Loading…",
  noLocalChats: "No local chats found",
  noImportHistory: "No import history",
  chatsCount: "{n} chats",
};

const IT: Record<MessageKey, string> = {
  tabSync: "Sync",
  tabChats: "Chat",
  tabSettings: "Impostazioni",
  synced: "Sincronizzato",
  notSynced: "Non sincronizzato",
  syncing: "Sincronizzazione...",
  syncError: "Errore di sync",
  never: "Mai",
  push: "Push",
  pull: "Pull",
  filesTracked: "file tracciati",
  fileTracked: "file tracciato",
  notLinked: "Non collegato",
  chatsInBackup: "Chat nel backup: {remote} remote · {local} locali",
  chatsLocalNotInBackup: "Chat: {local} locali (non ancora nel backup)",
  chatsNotIncluded: "Chat: non incluse nella sync",
  syncNow: "Sincronizza ora",
  actions: "Azioni",
  export: "Esporta",
  import: "Importa",
  history: "Cronologia",
  noHistory: "Nessuna cronologia di sync",
  prev: "Prec",
  next: "Succ",
  historyShowFiles: "Mostra i file di questa sync",
  historyNoFiles: "Elenco file non registrato per questa voce",
  historyFiles: "{n} file",
  historyFilesRatio: "{changed} / {total} file",
  auto: "auto",
  autoSync: "Auto-sync",
  enablePeriodicAutoSync: "Abilita auto-sync periodico",
  interval: "Intervallo",
  seconds: "secondi",
  minutes: "minuti",
  minIntervalHint: "L'intervallo minimo è 30 secondi.",
  destination: "Destinazione",
  remoteType: "Tipo remote",
  githubGist: "GitHub Gist",
  githubRepository: "Repository GitHub",
  repositoryOwnerName: "Repository (owner/name)",
  branch: "Branch",
  pathInRepo: "Path nel repo",
  connectRepository: "Collega repository",
  connectGithub: "Collega GitHub",
  connectRepoHint:
    "Collega verifica il PAT e l'accesso al repo. Se manca puoi crearlo (privato o pubblico). Formato: FaberVi/my-backup-repo.",
  connectGistHint:
    "Salva un PAT con scope gist e scopre un Gist Cursor Sync esistente, se presente.",
  language: "Lingua",
  languageEn: "English",
  languageIt: "Italiano",
  appearance: "Aspetto",
  chatSync: "Sync chat",
  includeChats: "Includi chat in Sync Now / Push / Pull",
  syncOnlyFullBackups: "Sincronizza solo chat riprendibili (salta solo-transcript)",
  pullUpdates: "Aggiorna le chat locali dal remote al pull",
  pullUpdatePolicy: "Policy aggiornamento pull",
  chatSyncHint:
    "Il pull importa le chat nuove di default. Abilita gli aggiornamenti per aggiornare chat già presenti su questa macchina.",
  chatImport: "Import chat",
  activateAfterImport: "Attiva la chat dopo l'import",
  strictActivation: "Attivazione strict (richiede conferma)",
  protobufHydration: "Hydration protobuf da diskKv del bundle (consigliato)",
  ideHydration: "Hydration solo IDE (salta il path protobuf)",
  strictDiskGates: "Fallisci l'import se la hydration lascia la conversation vuota",
  bridgeWait: "Attesa bridge (secondi)",
  autoReloadAfterImport: "Ricarica automatica dopo l'import",
  pythonPath: "Path Python",
  activeOperation: "Operazione attiva",
  localChatsByProject: "Chat locali per progetto",
  importsAndBundles: "Import e bundle",
  clear: "Cancella",
  loading: "Caricamento…",
  noLocalChats: "Nessuna chat locale trovata",
  noImportHistory: "Nessuna cronologia import",
  chatsCount: "{n} chat",
};

const CATALOG: Record<UiLanguage, Record<MessageKey, string>> = {
  en: EN,
  it: IT,
};

export function readUiLanguage(): UiLanguage {
  const raw = vscode.workspace
    .getConfiguration("cursorSync")
    .get<string>("ui.language");
  if (raw === "it" || raw === "en") {
    return raw;
  }
  const env = vscode.env.language?.toLowerCase() ?? "";
  return env.startsWith("it") ? "it" : "en";
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

/** Strings the webview JS needs for dynamic UI. */
export function webviewI18nPayload(lang: UiLanguage = readUiLanguage()): Record<string, string> {
  return {
    loading: t("loading", undefined, lang),
    noLocalChats: t("noLocalChats", undefined, lang),
    noImportHistory: t("noImportHistory", undefined, lang),
    connectRepository: t("connectRepository", undefined, lang),
    connectGithub: t("connectGithub", undefined, lang),
    chatsCount: t("chatsCount", undefined, lang),
    prev: t("prev", undefined, lang),
    next: t("next", undefined, lang),
    clear: t("clear", undefined, lang),
  };
}
