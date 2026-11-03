/** Marketplace / view title. */
export const EXTENSION_DISPLAY_NAME = "Cursor Sync (Community)";

/** Short label for commands, status bar, and output channel. */
export const EXTENSION_LABEL = "Cursor Sync";

/** Upstream project (unchanged attribution). */
export const UPSTREAM_REPO_URL = "https://github.com/Marcelo-Barella/cursor-sync";
export const UPSTREAM_AUTHOR = "Marcelo Barella";

export function commandTitle(action: string): string {
  return `${EXTENSION_LABEL}: ${action}`;
}

export const SETTINGS_GIST_DESCRIPTION = "Cursor Sync - Settings Backup";

export const EXPORT_GIST_DESCRIPTION = "Cursor Sync - Export";
export const CHAT_EXPORT_GIST_DESCRIPTION = "Cursor Sync - Chat Export";
export const TRANSCRIPTS_EXPORT_GIST_DESCRIPTION = "Cursor Sync - Agent Transcripts Export";
export const REPO_SETTINGS_BACKUP_DESCRIPTION = "Cursor Sync settings backup";
