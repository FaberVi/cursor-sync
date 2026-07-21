import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import {
  discoverProjects,
  enumerateTranscriptFilesInConversation,
  findProjectMatchingOpenWorkspaceFolder,
  resolveProjectsRoot,
} from "../transcripts-discovery.js";
import { findStoreDbForConversation, resolveChatsRoot } from "../transcripts-cursor-paths.js";

export interface ConversationFileTargets {
  transcriptDir?: string;
  primaryJsonl?: string;
  chatDataDir?: string;
  storeDbPath?: string;
  projectDir?: string;
  agentTranscriptsDir?: string;
}

const TRANSCRIPT_SCAN_MAX_BYTES = 256 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function projectPaths(projectKey: string): {
  projectDir: string;
  agentTranscriptsDir: string;
} {
  const projectDir = path.join(resolveProjectsRoot(), projectKey);
  return {
    projectDir,
    agentTranscriptsDir: path.join(projectDir, "agent-transcripts"),
  };
}

export async function resolveConversationFileTargets(
  conversationId: string,
  workspaceKeyHint?: string,
  projectKeyHint?: string
): Promise<ConversationFileTargets> {
  const projectsRoot = resolveProjectsRoot();
  const projects = await discoverProjects(projectsRoot);
  let orderedProjects = projects;
  if (projectKeyHint) {
    const match = projects.filter((p) => p.folderName === projectKeyHint);
    orderedProjects = match.length > 0 ? match : projects;
  } else {
    const preferredProject = findProjectMatchingOpenWorkspaceFolder(projects);
    orderedProjects = preferredProject
      ? [preferredProject, ...projects.filter((p) => p.folderName !== preferredProject.folderName)]
      : projects;
  }

  let transcriptDir: string | undefined;
  let primaryJsonl: string | undefined;
  let projectDir: string | undefined;
  let agentTranscriptsDir: string | undefined;
  for (const project of orderedProjects) {
    const convDir = path.join(project.fullPath, "agent-transcripts", conversationId);
    projectDir = project.fullPath;
    agentTranscriptsDir = path.join(project.fullPath, "agent-transcripts");
    const files = await enumerateTranscriptFilesInConversation(
      project.fullPath,
      conversationId,
      TRANSCRIPT_SCAN_MAX_BYTES
    );
    if (files.length > 0) {
      transcriptDir = convDir;
      const preferred =
        files.find((f) => path.basename(f.absolutePath, ".jsonl") === conversationId) ??
        files[0];
      primaryJsonl = preferred?.absolutePath;
      break;
    }
    try {
      const stat = await fs.stat(convDir);
      if (stat.isDirectory()) {
        transcriptDir = convDir;
      }
    } catch {
      continue;
    }
    if (transcriptDir) {
      break;
    }
  }

  if (projectKeyHint && !projectDir) {
    const paths = projectPaths(projectKeyHint);
    projectDir = paths.projectDir;
    agentTranscriptsDir = paths.agentTranscriptsDir;
  }

  const store = await findStoreDbForConversation(conversationId);
  let chatDataDir: string | undefined;
  let storeDbPath: string | undefined;
  if (store) {
    storeDbPath = store.absolutePath;
    chatDataDir = path.dirname(store.absolutePath);
  } else if (workspaceKeyHint) {
    const hintedDir = path.join(resolveChatsRoot(), workspaceKeyHint, conversationId);
    const hintedStore = path.join(hintedDir, "store.db");
    try {
      const stat = await fs.stat(hintedStore);
      if (stat.isFile()) {
        storeDbPath = hintedStore;
        chatDataDir = hintedDir;
      }
    } catch {
      // no store on disk for this workspace key
    }
  }

  return {
    transcriptDir,
    primaryJsonl,
    chatDataDir,
    storeDbPath,
    projectDir,
    agentTranscriptsDir,
  };
}

async function revealPathInOsShell(fsPath: string): Promise<boolean> {
  const normalized = path.normalize(fsPath);
  try {
    const stat = await fs.stat(normalized);
    if (process.platform === "win32") {
      if (stat.isDirectory()) {
        await execFileAsync("explorer.exe", [normalized], { windowsHide: true });
      } else {
        await execFileAsync("explorer.exe", [`/select,${normalized}`], { windowsHide: true });
      }
      return true;
    }
    if (process.platform === "darwin") {
      if (stat.isDirectory()) {
        await execFileAsync("open", [normalized], { windowsHide: true });
      } else {
        await execFileAsync("open", ["-R", normalized], { windowsHide: true });
      }
      return true;
    }
    const target = stat.isDirectory() ? normalized : path.dirname(normalized);
    await execFileAsync("xdg-open", [target], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function revealFsPath(fsPath: string): Promise<void> {
  const uri = vscode.Uri.file(fsPath);
  // Cursor chat assets live under ~/.cursor (outside workspace): prefer OS reveal.
  const commands = ["revealFileInOS", "revealInExplorer"] as const;
  for (const commandId of commands) {
    try {
      await vscode.commands.executeCommand(commandId, uri);
      return;
    } catch {
      continue;
    }
  }
  if (await revealPathInOsShell(fsPath)) {
    return;
  }
  try {
    await vscode.env.openExternal(uri);
  } catch {
    void vscode.window.showWarningMessage(`Could not open folder in file manager: ${fsPath}`);
  }
}

async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.stat(fsPath);
    return true;
  } catch {
    return false;
  }
}

function md5FolderKey(folderFsPath: string): string {
  return createHash("md5").update(folderFsPath).digest("hex");
}

export async function openTranscriptForConversation(
  conversationId: string,
  workspaceKeyHint?: string,
  projectKeyHint?: string
): Promise<boolean> {
  const targets = await resolveConversationFileTargets(
    conversationId,
    workspaceKeyHint,
    projectKeyHint
  );
  if (!targets.primaryJsonl) {
    return false;
  }
  await vscode.commands.executeCommand(
    "vscode.open",
    vscode.Uri.file(targets.primaryJsonl)
  );
  return true;
}

export async function revealConversationFiles(
  conversationId: string,
  workspaceKeyHint?: string,
  projectKeyHint?: string
): Promise<void> {
  const targets = await resolveConversationFileTargets(
    conversationId,
    workspaceKeyHint,
    projectKeyHint
  );
  if (targets.primaryJsonl && (await pathExists(targets.primaryJsonl))) {
    await revealFsPath(targets.primaryJsonl);
    return;
  }
  if (targets.storeDbPath && (await pathExists(targets.storeDbPath))) {
    await revealFsPath(targets.storeDbPath);
    return;
  }
  if (targets.transcriptDir && (await pathExists(targets.transcriptDir))) {
    await revealFsPath(targets.transcriptDir);
    return;
  }
  if (targets.chatDataDir && (await pathExists(targets.chatDataDir))) {
    await revealFsPath(targets.chatDataDir);
    return;
  }

  if (targets.agentTranscriptsDir && (await pathExists(targets.agentTranscriptsDir))) {
    await revealFsPath(targets.agentTranscriptsDir);
    void vscode.window.showInformationMessage(
      "This chat has no per-conversation folder yet (header-only in Composer state). Opened the project agent-transcripts folder."
    );
    return;
  }

  if (targets.projectDir && (await pathExists(targets.projectDir))) {
    await revealFsPath(targets.projectDir);
    void vscode.window.showInformationMessage(
      "This chat has no transcript files on disk yet. Opened the Cursor project folder."
    );
    return;
  }

  if (projectKeyHint) {
    const paths = projectPaths(projectKeyHint);
    if (await pathExists(paths.agentTranscriptsDir)) {
      await revealFsPath(paths.agentTranscriptsDir);
      void vscode.window.showInformationMessage(
        "This chat exists only in Composer state (no jsonl on disk). Opened agent-transcripts for this project."
      );
      return;
    }
    if (await pathExists(paths.projectDir)) {
      await revealFsPath(paths.projectDir);
      void vscode.window.showInformationMessage(
        "This chat exists only in Composer state (no jsonl on disk). Opened the Cursor project folder."
      );
      return;
    }
  }

  const folders = vscode.workspace.workspaceFolders;
  const workspaceKey =
    workspaceKeyHint ??
    (folders?.[0]
      ? md5FolderKey(path.resolve(folders[0].uri.fsPath))
      : undefined);
  const fallbackDir =
    workspaceKey && path.join(resolveChatsRoot(), workspaceKey, conversationId);
  if (fallbackDir && (await pathExists(fallbackDir))) {
    await revealFsPath(fallbackDir);
    return;
  }

  void vscode.window.showWarningMessage(
    `No on-disk folder found for conversation ${conversationId}. It may exist only in Composer state (header) without transcript files.`
  );
}
