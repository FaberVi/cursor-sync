import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  discoverAllConversations,
  discoverBackupEligibleConversations,
  discoverConversationsForOpenWorkspace,
  discoveredToExportRows,
  filterBackupEligibleConversations,
  type ConversationExportRow,
} from "./chat-discovery.js";
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import { workspaceQuickPickLabel } from "./chat-workspace-label.js";
import { resolveSyncRoots } from "./paths.js";
import { __chatPersistenceInternals } from "./transcripts.js";

function resolveChatsRoot(): string {
  return __chatPersistenceInternals.resolveChatsRoot();
}

export interface WorkspaceDir {
  name: string;
  fullPath: string;
}

export type { ConversationExportRow } from "./chat-discovery.js";

export interface ChatExportSelection {
  workspaceKey: string;
  conversationIds: string[];
}

export interface ListConversationsOptions {
  workspaceIndex?: Map<string, string>;
  globalIndex?: Map<string, string>;
}

export async function listChatsWorkspaceDirs(chatsRoot: string): Promise<WorkspaceDir[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, fullPath: path.join(chatsRoot, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listConversationsForWorkspace(
  workspaceKey: string,
  chatsRoot: string,
  projectsRoot: string,
  options: ListConversationsOptions = {}
): Promise<ConversationExportRow[]> {
  const all = filterBackupEligibleConversations(await discoverAllConversations());
  const filtered = all.filter(
    (d) => d.workspaceKey === workspaceKey || (!d.workspaceKey && Boolean(workspaceKey))
  );
  return discoveredToExportRows(filtered, {
    workspaceIndex: options.workspaceIndex,
    globalIndex: options.globalIndex,
    projectsRoot,
  });
}

export async function listConversationsForOpenWorkspace(
  options: ListConversationsOptions = {}
): Promise<ConversationExportRow[]> {
  const { dotCursor } = resolveSyncRoots();
  const projectsRoot = path.join(dotCursor, "projects");
  const discovered = filterBackupEligibleConversations(
    await discoverConversationsForOpenWorkspace()
  );
  return discoveredToExportRows(discovered, { ...options, projectsRoot });
}

export async function pickChatsForExport(): Promise<ChatExportSelection | null> {
  const chatsRoot = resolveChatsRoot();
  const discovered = await discoverBackupEligibleConversations();
  if (discovered.length === 0) {
    vscode.window.showErrorMessage(
      "No local chats found. Create chats in Cursor or open a workspace with agent-transcripts."
    );
    return null;
  }

  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const byWorkspace = new Map<string, typeof discovered>();
  for (const item of discovered) {
    const key = item.workspaceKey || "_unknown";
    const list = byWorkspace.get(key) ?? [];
    list.push(item);
    byWorkspace.set(key, list);
  }

  let workspaceKey: string;
  const workspaceKeys = [...byWorkspace.keys()].sort();
  if (workspaceKeys.length === 1) {
    workspaceKey = workspaceKeys[0]!;
  } else {
    const picks = workspaceKeys.map((key) => {
      const count = byWorkspace.get(key)?.length ?? 0;
      if (key === "_unknown") {
        return {
          label: "Unknown workspace",
          description: key,
          detail: `${count} chat(s)`,
        };
      }
      const row = workspaceQuickPickLabel(key, folderMap);
      return {
        label: row.label,
        description: key,
        detail: `${count} chat(s) · ${row.description}`,
      };
    });
    const pick = await vscode.window.showQuickPick(picks, {
      title: "Select workspace for chat export",
      placeHolder: "Choose the workspace whose chats you want to export",
      ignoreFocusOut: true,
    });
    if (!pick?.description) {
      return null;
    }
    workspaceKey = pick.description;
  }

  const workspaceDiscovered = byWorkspace.get(workspaceKey) ?? [];
  const conversations = await discoveredToExportRows(workspaceDiscovered);
  if (conversations.length === 0) {
    vscode.window.showInformationMessage("No conversations found in this workspace.");
    return null;
  }

  const convPicks = await vscode.window.showQuickPick(
    conversations.map((c) => ({
      label: c.label,
      description: c.conversationId,
      detail: c.detail,
      picked: true,
    })),
    {
      canPickMany: true,
      title: `Select conversations to export (${conversations.length} found)`,
      placeHolder:
        "Each selection exports store.db (scoped workspace), transcripts, and sidebar metadata when available",
      ignoreFocusOut: true,
    }
  );

  if (!convPicks || convPicks.length === 0) {
    return null;
  }

  return {
    workspaceKey: workspaceKey === "_unknown" ? "" : workspaceKey,
    conversationIds: convPicks.map((p) => p.description!).filter(Boolean),
  };
}
