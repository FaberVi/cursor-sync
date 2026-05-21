import * as fs from "node:fs/promises";
import * as path from "node:path";
import { summarizeTranscriptForSidebar } from "./transcript-bundle.js";

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
