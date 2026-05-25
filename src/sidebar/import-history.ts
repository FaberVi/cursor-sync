import * as vscode from "vscode";

const HISTORY_KEY = "cursorSync.chatImports";
const MAX = 200;

export interface ChatImportHistoryEntry {
  conversationId: string;
  transcriptsWritten: number;
  storeWritten: boolean;
  sidebarMerged: boolean;
  warnings: number;
  timestamp: string;
}

export async function recordImport(
  context: vscode.ExtensionContext,
  entry: ChatImportHistoryEntry
): Promise<void> {
  if (!context.globalState) {
    return;
  }
  const existing = listImports(context);
  const next = [entry, ...existing].slice(0, MAX);
  await context.globalState.update(HISTORY_KEY, next);
}

export function listImports(
  context: vscode.ExtensionContext
): ChatImportHistoryEntry[] {
  if (!context.globalState) {
    return [];
  }
  return context.globalState.get<ChatImportHistoryEntry[]>(HISTORY_KEY) ?? [];
}

export async function clearImports(context: vscode.ExtensionContext): Promise<void> {
  if (!context.globalState) {
    return;
  }
  await context.globalState.update(HISTORY_KEY, []);
}
