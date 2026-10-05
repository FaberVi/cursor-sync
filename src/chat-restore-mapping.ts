import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import {
  discoverProjects,
  findProjectMatchingOpenWorkspaceFolder,
} from "./transcripts.js";
import {
  folderToProjectKey,
  buildChatsKeyToFolderMap,
} from "./chat-workspace-context.js";
import { resolveSyncRoots } from "./paths.js";
import { humanWorkspaceLabel, projectQuickPickLabel } from "./chat-workspace-label.js";
import type { ChatBundle } from "./chat-persistence.js";
import { logChatRestoreDebug } from "./chat-restore-debug.js";

export function resolveProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

export async function resolveImportProjectMapping(
  sourceProjectKeys: string[],
  folderFsPath: string
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  if (sourceProjectKeys.length === 0) {
    return mapping;
  }

  const localProjects = await discoverProjects();
  const encoded = folderToProjectKey(folderFsPath);
  let targetKey =
    localProjects.find((p) => path.resolve(p.fullPath) === path.resolve(folderFsPath))
      ?.folderName ??
    localProjects.find((p) => p.folderName === encoded)?.folderName;

  if (!targetKey) {
    const openFolders = vscode.workspace.workspaceFolders;
    const openMatchesDest =
      openFolders?.some((wf) => path.resolve(wf.uri.fsPath) === path.resolve(folderFsPath)) ??
      false;
    const matched = openMatchesDest
      ? findProjectMatchingOpenWorkspaceFolder(localProjects, openFolders)
      : undefined;
    targetKey = matched?.folderName ?? encoded;
  }

  for (const sourceKey of sourceProjectKeys) {
    mapping.set(sourceKey, targetKey);
  }
  return mapping;
}

export function applyProjectMappingToBundle(
  bundle: ChatBundle,
  projectMapping: Map<string, string>
): ChatBundle {
  if (projectMapping.size === 0) {
    return bundle;
  }
  const transcriptFiles = bundle.transcriptFiles.map((tf) => {
    const segments = tf.relativePath.split("/");
    if (segments.length === 0) {
      return tf;
    }
    const sourceKey = segments[0]!;
    const mappedKey = projectMapping.get(sourceKey) ?? sourceKey;
    return {
      ...tf,
      relativePath: [mappedKey, ...segments.slice(1)].join("/"),
    };
  });
  return { ...bundle, transcriptFiles };
}

export async function promptForTargetProject(
  sourceProjectKeys: string[]
): Promise<Map<string, string> | null> {
  const projectsRoot = resolveProjectsRoot();
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    vscode.window.showErrorMessage(
      `Cannot read projects directory: ${projectsRoot}. Open a project in Cursor first.`
    );
    return null;
  }

  const localProjects = projectDirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found. Open a project in Cursor first to create a project directory."
    );
    return null;
  }

  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);

  const mapping = new Map<string, string>();

  for (const sourceKey of sourceProjectKeys) {
    const sourceLabel = humanWorkspaceLabel(sourceKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
      label: projectQuickPickLabel(p.name, folderMap),
      description: p.name,
      detail: path.join(projectsRoot, p.name),
    }));
    picks.unshift({ label: "(Skip)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" to a local project`,
      placeHolder: `Select the local project to receive chat transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      return null;
    }

    if (selected.description === "skip") {
      continue;
    }

    mapping.set(sourceKey, selected.description!);
  }

  return mapping;
}

export async function resolveRestoreProjectMapping(
  sourceProjectKeys: string[],
  folderFsPath: string,
  transcriptFileCount: number,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<Map<string, string> | null> {
  const projectMapping = await resolveImportProjectMapping(sourceProjectKeys, folderFsPath);
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  const autoMapImport =
    cfg.get<boolean>("chatImport.autoMapToOpenWorkspace") ?? true;
  const needsPrompt =
    sourceProjectKeys.length > 0 &&
    transcriptFileCount > 0 &&
    (!autoMapImport || sourceProjectKeys.some((k) => !projectMapping.has(k)));

  if (needsPrompt) {
    progress?.report({ message: "Mapping projects..." });
    const mapping = await promptForTargetProject(sourceProjectKeys);
    if (mapping === null) {
      return null;
    }
    return mapping;
  }
  if (projectMapping.size > 0) {
    logChatRestoreDebug(
      `project mapping auto target=${[...new Set(projectMapping.values())].join(",")} sources=[${[...projectMapping.keys()].join(", ")}]`
    );
  }
  return projectMapping;
}
