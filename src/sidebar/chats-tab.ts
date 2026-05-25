import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { listConversationsForWorkspace } from "../chat-export-ux.js";
import { __chatPersistenceInternals } from "../transcripts.js";
import { resolveSyncRoots } from "../paths.js";
import type { ConversationExportRow } from "../chat-export-ux.js";
import type { BundleDiscoveryEntry } from "./bundle-discovery.js";
import { listLocalBundles } from "./bundle-discovery.js";
import { listImports } from "./import-history.js";
import type { ChatImportHistoryEntry } from "./import-history.js";

function resolveChatsRoot(): string {
  return __chatPersistenceInternals.resolveChatsRoot();
}

export interface ChatsRecentResult {
  rows: ConversationExportRow[];
}

export interface ChatsImportsResult {
  rows: ChatImportHistoryEntry[];
}

export interface ChatsBundlesResult {
  entries: BundleDiscoveryEntry[];
}

function resolveProjectsRoot(): string {
  const { dotCursor } = resolveSyncRoots();
  return path.join(dotCursor, "projects");
}

export async function listLocalConversations(): Promise<ChatsRecentResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { rows: [] };
  }
  const folder = folders[0];
  if (!folder) {
    return { rows: [] };
  }
  const workspaceKey = crypto
    .createHash("md5")
    .update(folder.uri.fsPath)
    .digest("hex");
  const chatsRoot = resolveChatsRoot();
  const projectsRoot = resolveProjectsRoot();
  try {
    const rows = await listConversationsForWorkspace(workspaceKey, chatsRoot, projectsRoot);
    return { rows };
  } catch {
    return { rows: [] };
  }
}

export function listImportHistory(
  context: vscode.ExtensionContext
): ChatsImportsResult {
  return { rows: listImports(context) };
}

export async function listBundles(
  context: vscode.ExtensionContext
): Promise<ChatsBundlesResult> {
  const entries = await listLocalBundles(context);
  return { entries };
}

export async function revealTranscriptsForConversation(
  conversationId: string
): Promise<void> {
  const { dotCursor } = resolveSyncRoots();
  const projectsRoot = path.join(dotCursor, "projects");
  let projectDirs: import("node:fs").Dirent[];
  try {
    const fs = await import("node:fs/promises");
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const transcriptDir = path.join(
      projectsRoot,
      proj.name,
      "agent-transcripts",
      conversationId
    );
    try {
      const fs = await import("node:fs/promises");
      await fs.stat(transcriptDir);
      const uri = vscode.Uri.file(transcriptDir);
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    } catch {
      continue;
    }
  }
  vscode.window.showWarningMessage(
    `No transcript directory found for conversation ${conversationId}`
  );
}
