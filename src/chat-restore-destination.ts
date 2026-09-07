import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildChatsKeyToFolderMap,
  expandUserFolder,
  pathsReferToSameFolder,
} from "./chat-workspace-context.js";
import { workspaceQuickPickLabel } from "./chat-workspace-label.js";
import { resolveSyncRoots } from "./paths.js";

export { pathsReferToSameFolder };

export interface RestoreDestinationCache {
  resolvedByTilde: Map<string, string | null>;
}

export function createRestoreDestinationCache(): RestoreDestinationCache {
  return { resolvedByTilde: new Map() };
}

export async function pathIsExistingDirectory(folderFsPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(folderFsPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export function isOpenWorkspaceFolder(
  folderFsPath: string,
  openFolders: readonly { uri: { fsPath: string } }[] | undefined = vscode.workspace
    .workspaceFolders
): boolean {
  if (!openFolders || openFolders.length === 0) {
    return false;
  }
  return openFolders.some((wf) => pathsReferToSameFolder(wf.uri.fsPath, folderFsPath));
}

export interface ResolveRestoreWorkspaceFolderOptions {
  cache?: RestoreDestinationCache;
  folderMap?: Map<string, string>;
  homeDir?: string;
  promptMissingFolder?: (
    sourceFolderTilde: string,
    folderMap: Map<string, string>
  ) => Promise<string | undefined>;
}

async function defaultPromptMissingFolder(
  sourceFolderTilde: string,
  folderMap: Map<string, string>
): Promise<string | undefined> {
  type FolderPick = vscode.QuickPickItem & { folderFsPath: string };
  const picks: FolderPick[] = [...folderMap.entries()].map(([chatsKey, folderFsPath]) => {
    const row = workspaceQuickPickLabel(chatsKey, folderMap);
    return {
      label: row.label,
      description: row.description,
      folderFsPath,
    };
  });
  if (picks.length === 0) {
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(picks, {
    title: `Folder not found: ${sourceFolderTilde}`,
    placeHolder: "Select a local folder to restore this project's chats",
    ignoreFocusOut: true,
  });
  return selected?.folderFsPath;
}

/**
 * Resolve the destination Git-workspace folder for a chat restore.
 * Uses `sourceFolderTilde` when present; never treats sourceWorkspaceKey as a path.
 */
export async function resolveRestoreWorkspaceFolder(
  bundle: { sourceFolderTilde?: string },
  options: ResolveRestoreWorkspaceFolderOptions = {}
): Promise<string | undefined> {
  const tilde = (bundle.sourceFolderTilde ?? "").trim();
  if (!tilde) {
    return undefined;
  }
  const cache = options.cache ?? createRestoreDestinationCache();
  if (cache.resolvedByTilde.has(tilde)) {
    return cache.resolvedByTilde.get(tilde) ?? undefined;
  }
  const expanded = path.resolve(expandUserFolder(tilde, options.homeDir ?? os.homedir()));
  if (await pathIsExistingDirectory(expanded)) {
    cache.resolvedByTilde.set(tilde, expanded);
    return expanded;
  }
  const folderMap =
    options.folderMap ?? (await buildChatsKeyToFolderMap(resolveSyncRoots().cursorUser));
  const prompt = options.promptMissingFolder ?? defaultPromptMissingFolder;
  const picked = await prompt(tilde, folderMap);
  cache.resolvedByTilde.set(tilde, picked ?? null);
  return picked;
}
