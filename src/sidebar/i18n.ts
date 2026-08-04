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
  | "destBadgeGist"
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
  | "openAnyway"
  | "cancel"
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
  historyFilesCount: "{n} file",
  historyFilesCountRatio: "{changed} / {total} files",
  historyFilesPlaceholder: "Files involved in this sync",
  historyFileNotFound: "File not found on disk: {path}",
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
  pullPolicySkip: "Skip",
  pullPolicyRemoteWins: "Remote wins",
  pullPolicyNewerWins: "Newer wins",
  pullPolicyAsk: "Ask",
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
  pythonPathHint:
    "Set cursorSync.chatImport.pythonPath in Cursor Settings (not editable here).",
  activeOperation: "Active Operation",
  localChatsByProject: "Local chats by project",
  importsAndBundles: "Imports & bundles",
  bundleFiles: "Bundle files",
  clear: "Clear",
  loading: "Loading…",
  noLocalChats: "No local chats found",
  noImportHistory: "No import history",
  noBundleFiles: "No bundle files found",
  chatsCount: "{n} chats",
  timeJustNow: "just now",
  timeMinutesAgo: "{n}m ago",
  timeHoursAgo: "{n}h ago",
  timeDaysAgo: "{n}d ago",
  open: "Open",
  opening: "Opening…",
  files: "Files",
  unknownProject: "Unknown project",
  invalidSetting: "Invalid setting",
  phasePrefix: "Phase {phase}",
  textOnlyL4Badge: "text-only L4",
  textOnlyL4Detail:
    "text-only Layer 4 (no diskKvSnapshot); tool/MCP UI may not match source",
  warnCount: "{n} warn",
  toolBubblesCount: "{n} tool bubbles",
  transcriptsWritten: "{n} transcripts",
  syncFailed: "Failed",
  destBadgeRepo: "Repo",
  destBadgeGist: "Gist",
  extensionVersionTitle: "Extension version",
  invalidConversationId: "Invalid conversation id",
  invalidWorkspaceKey: "Invalid workspace key",
  invalidProjectKey: "Invalid project key",
  openWorkspaceFirst: "Open a workspace folder first.",
  missingConversationIdOpen: "Missing conversation id for Open.",
  missingConversationIdFiles: "Missing conversation id for Files.",
  couldNotOpenChat: "Could not open chat: {error}",
  couldNotRevealFiles: "Could not reveal files: {error}",
  historyEntryNotFound: "History entry not found.",
  historyNoFileListRecorded:
    "File list was not recorded for this entry. New syncs will keep the list.",
  openAnyway: "Open anyway",
  cancel: "Cancel",
  openedTranscriptReload:
    "Opened transcript file. Reload Window if the native composer view stays empty.",
  couldNotOpenChatDisk:
    "Could not open chat {id}. No composer handle or transcript file found on disk.",
  revealHeaderOnlyAgentTranscripts:
    "This chat has no per-conversation folder yet (header-only in Composer state). Opened the project agent-transcripts folder.",
  revealNoTranscriptProject:
    "This chat has no transcript files on disk yet. Opened the Cursor project folder.",
  revealComposerOnlyAgentTranscripts:
    "This chat exists only in Composer state (no jsonl on disk). Opened agent-transcripts for this project.",
  revealComposerOnlyProject:
    "This chat exists only in Composer state (no jsonl on disk). Opened the Cursor project folder.",
  revealNoDiskFolder:
    "No on-disk folder found for conversation {id}. It may exist only in Composer state (header) without transcript files.",
  tierFull: "Full backup",
  tierResume: "Resumable",
  tierPartial: "Partial",
  tierArchive: "Archive only",
  tierWarningArchive:
    "Transcript-only: open in Composer on source machine before sync for tool/MCP fidelity.",
  tierWarningPartial:
    "store.db present but Layer 4 tool bubbles missing; tool/MCP UI may differ on import.",
  openTierWarningArchive:
    "This chat is transcript-only (Archive). Composer may open empty or show only JSONL. Open it in Composer on the source machine and sync again for full fidelity.",
  openTierWarningPartial:
    "This chat has partial backup fidelity (store without Layer 4 tool bubbles). Tool/MCP cards may differ after open.",
  backupDetailJsonl: "{n} jsonl",
  backupDetailNoJsonl: "no jsonl",
  backupDetailStore: "store.db",
  backupDetailNoStore: "no store.db",
  backupDetailSubagentJsonl: "{n} subagent jsonl",
  backupDetailDiskKvRows: "diskKv {n} rows",
  backupDetailToolBubbles: "{n} tool bubbles",
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
  historyFilesCount: "{n} file",
  historyFilesCountRatio: "{changed} / {total} file",
  historyFilesPlaceholder: "File coinvolti in questa sync",
  historyFileNotFound: "File non trovato su disco: {path}",
  auto: "auto",
  autoSync: "Sincronizzazione automatica",
  enablePeriodicAutoSync: "Abilita auto-sync periodico",
  interval: "Intervallo",
  seconds: "secondi",
  minutes: "minuti",
  minIntervalHint: "L'intervallo minimo è 30 secondi.",
  destination: "Destinazione",
  remoteType: "Tipo remote",
  githubGist: "GitHub Gist",
  githubRepository: "Repository GitHub",
  repositoryOwnerName: "Repository (owner/nome)",
  branch: "Branch",
  pathInRepo: "Percorso nel repo",
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
  pullPolicySkip: "Salta",
  pullPolicyRemoteWins: "Vince il remote",
  pullPolicyNewerWins: "Vince il più recente",
  pullPolicyAsk: "Chiedi",
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
  pythonPath: "Percorso Python",
  pythonPathHint:
    "Imposta cursorSync.chatImport.pythonPath nelle Impostazioni di Cursor (non modificabile qui).",
  activeOperation: "Operazione attiva",
  localChatsByProject: "Chat locali per progetto",
  importsAndBundles: "Import e bundle",
  bundleFiles: "File bundle",
  clear: "Cancella",
  loading: "Caricamento…",
  noLocalChats: "Nessuna chat locale trovata",
  noImportHistory: "Nessuna cronologia import",
  noBundleFiles: "Nessun file bundle trovato",
  chatsCount: "{n} chat",
  timeJustNow: "proprio ora",
  timeMinutesAgo: "{n} min fa",
  timeHoursAgo: "{n} h fa",
  timeDaysAgo: "{n} g fa",
  open: "Apri",
  opening: "Apertura…",
  files: "File",
  unknownProject: "Progetto sconosciuto",
  invalidSetting: "Impostazione non valida",
  phasePrefix: "Fase {phase}",
  textOnlyL4Badge: "solo testo L4",
  textOnlyL4Detail:
    "solo Layer 4 testuale (senza diskKvSnapshot); l'UI tool/MCP potrebbe non corrispondere alla sorgente",
  warnCount: "{n} avvisi",
  toolBubblesCount: "{n} bolle tool",
  transcriptsWritten: "{n} transcript",
  syncFailed: "Fallito",
  destBadgeRepo: "Repo",
  destBadgeGist: "Gist",
  extensionVersionTitle: "Versione estensione",
  invalidConversationId: "ID conversazione non valido",
  invalidWorkspaceKey: "Chiave workspace non valida",
  invalidProjectKey: "Chiave progetto non valida",
  openWorkspaceFirst: "Apri prima una cartella workspace.",
  missingConversationIdOpen: "ID conversazione mancante per Apri.",
  missingConversationIdFiles: "ID conversazione mancante per File.",
  couldNotOpenChat: "Impossibile aprire la chat: {error}",
  couldNotRevealFiles: "Impossibile mostrare i file: {error}",
  historyEntryNotFound: "Voce cronologia non trovata.",
  historyNoFileListRecorded:
    "Elenco file non registrato per questa voce. Le sync future lo conserveranno.",
  openAnyway: "Apri comunque",
  cancel: "Annulla",
  openedTranscriptReload:
    "File transcript aperto. Ricarica la finestra se la vista Composer nativa resta vuota.",
  couldNotOpenChatDisk:
    "Impossibile aprire la chat {id}. Nessun handle Composer o file transcript su disco.",
  revealHeaderOnlyAgentTranscripts:
    "Questa chat non ha ancora una cartella dedicata (solo header nello stato Composer). Aperta la cartella agent-transcripts del progetto.",
  revealNoTranscriptProject:
    "Questa chat non ha ancora file transcript su disco. Aperta la cartella progetto Cursor.",
  revealComposerOnlyAgentTranscripts:
    "Questa chat esiste solo nello stato Composer (nessun jsonl su disco). Aperta agent-transcripts per questo progetto.",
  revealComposerOnlyProject:
    "Questa chat esiste solo nello stato Composer (nessun jsonl su disco). Aperta la cartella progetto Cursor.",
  revealNoDiskFolder:
    "Nessuna cartella su disco per la conversazione {id}. Potrebbe esistere solo nello stato Composer (header) senza file transcript.",
  tierFull: "Backup completo",
  tierResume: "Riprendibile",
  tierPartial: "Parziale",
  tierArchive: "Solo archivio",
  tierWarningArchive:
    "Solo transcript: apri in Composer sulla macchina sorgente prima della sync per la fedeltà tool/MCP.",
  tierWarningPartial:
    "store.db presente ma bolle tool Layer 4 mancanti; l'UI tool/MCP può differire dopo l'import.",
  openTierWarningArchive:
    "Questa chat è solo transcript (Archivio). Composer può aprirsi vuoto o mostrare solo JSONL. Aprila in Composer sulla macchina sorgente e sincronizza di nuovo per la fedeltà completa.",
  openTierWarningPartial:
    "Questa chat ha fedeltà backup parziale (store senza bolle tool Layer 4). Le card tool/MCP possono differire dopo l'apertura.",
  backupDetailJsonl: "{n} jsonl",
  backupDetailNoJsonl: "nessun jsonl",
  backupDetailStore: "store.db",
  backupDetailNoStore: "nessun store.db",
  backupDetailSubagentJsonl: "{n} jsonl subagent",
  backupDetailDiskKvRows: "diskKv {n} righe",
  backupDetailToolBubbles: "{n} bolle tool",
};

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
    "noImportHistory",
    "noBundleFiles",
    "connectRepository",
    "connectGithub",
    "chatsCount",
    "prev",
    "next",
    "clear",
    "syncNow",
    "push",
    "pull",
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
