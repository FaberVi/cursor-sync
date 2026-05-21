import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { humanWorkspaceLabel } from "./chat-workspace-label.js";
import { summarizeTranscriptForSidebar } from "./transcript-bundle.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { resolveChatsRoot } = __chatPersistenceInternals;

export interface WorkspaceDir {
  name: string;
  fullPath: string;
}

export interface ConversationExportRow {
  conversationId: string;
  label: string;
  description: string;
  detail: string;
}

export interface ChatExportSelection {
  workspaceKey: string;
  conversationIds: string[];
}

function resolveProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
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

async function countJsonlForConversation(
  projectsRoot: string,
  conversationId: string
): Promise<number> {
  let count = 0;
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
    let files: string[];
    try {
      files = await fs.readdir(transcriptDir);
    } catch {
      continue;
    }
    count += files.filter((f) => f.endsWith(".jsonl")).length;
  }
  return count;
}

async function transcriptTitleForConversation(
  projectsRoot: string,
  conversationId: string
): Promise<string | null> {
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
    let files: string[];
    try {
      files = await fs.readdir(transcriptDir);
    } catch {
      continue;
    }
    const jsonl = files.find((f) => f.endsWith(".jsonl"));
    if (!jsonl) continue;
    try {
      const content = (await fs.readFile(path.join(transcriptDir, jsonl), "utf-8")).toString();
      return summarizeTranscriptForSidebar(content, conversationId).title;
    } catch {
      continue;
    }
  }
  return null;
}

export async function listConversationsForWorkspace(
  workspaceKey: string,
  chatsRoot: string,
  projectsRoot: string
): Promise<ConversationExportRow[]> {
  const workspacePath = path.join(chatsRoot, workspaceKey);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(workspacePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: ConversationExportRow[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const conversationId = ent.name;
    const storePath = path.join(workspacePath, conversationId, "store.db");
    try {
      const stat = await fs.stat(storePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const jsonlCount = await countJsonlForConversation(projectsRoot, conversationId);
    const title =
      (await transcriptTitleForConversation(projectsRoot, conversationId)) ?? conversationId;
    const parts = [
      jsonlCount > 0 ? `${jsonlCount} jsonl` : "no jsonl",
      "store.db",
    ];
    rows.push({
      conversationId,
      label: title,
      description: conversationId,
      detail: parts.join(" · "),
    });
  }
  return rows.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}

export async function pickChatsForExport(): Promise<ChatExportSelection | null> {
  const chatsRoot = resolveChatsRoot();
  const workspaces = await listChatsWorkspaceDirs(chatsRoot);

  if (workspaces.length === 0) {
    vscode.window.showErrorMessage(
      "No local chat workspaces found. Open a workspace in Cursor first."
    );
    return null;
  }

  let workspaceKey: string;
  if (workspaces.length === 1) {
    workspaceKey = workspaces[0]!.name;
  } else {
    const pick = await vscode.window.showQuickPick(
      workspaces.map((w) => ({
        label: humanWorkspaceLabel(w.name),
        description: w.name,
        detail: w.fullPath,
      })),
      {
        title: "Select workspace for chat export",
        placeHolder: "Choose the workspace whose chats you want to export",
        ignoreFocusOut: true,
      }
    );
    if (!pick?.description) return null;
    workspaceKey = pick.description;
  }

  const projectsRoot = resolveProjectsRoot();
  const conversations = await listConversationsForWorkspace(
    workspaceKey,
    chatsRoot,
    projectsRoot
  );

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

  if (!convPicks || convPicks.length === 0) return null;

  return {
    workspaceKey,
    conversationIds: convPicks.map((p) => p.description!).filter(Boolean),
  };
}
