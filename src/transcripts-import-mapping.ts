import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { getLogger } from "./diagnostics.js";
import type { TranscriptManifestV2 } from "./transcript-bundle.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import type { ProjectInfo } from "./transcripts-discovery.js";
import { humanLabel } from "./transcripts-discovery.js";

export async function promptForProjectMapping(
  sourceProjectKeys: string[],
  sourceProjects: Record<string, { fileCount: number }>,
  localProjects: ProjectInfo[],
  logger: ReturnType<typeof getLogger>
): Promise<Map<string, ProjectInfo> | null> {
  if (sourceProjectKeys.length === 0) {
    vscode.window.showInformationMessage("No source projects found in the transcript export.");
    return new Map();
  }

  const projectMapping: Map<string, ProjectInfo> = new Map();

  for (const sourceProjectKey of sourceProjectKeys.sort()) {
    const sourceInfo = sourceProjects[sourceProjectKey];
    const sourceLabel = humanLabel(sourceProjectKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((project) => ({
      label: project.label,
      description: project.folderName,
      detail: project.fullPath,
    }));

    picks.unshift({ label: "(Skip this project)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" (${sourceInfo.fileCount} file(s)) to a local project`,
      placeHolder: `Select the local project to receive transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during project mapping`);
      return null;
    }

    if (selected.description === "skip") {
      continue;
    }

    const targetProject = localProjects.find(
      (project) => project.folderName === selected.description
    );
    if (targetProject) {
      projectMapping.set(sourceProjectKey, targetProject);
    }
  }

  return projectMapping;
}

export function collectRequiredStoreWorkspaceKeys(
  manifest: TranscriptManifestV2,
  selectedConversationKeys: Set<string>
): string[] {
  const keys = new Set<string>();
  for (const [conversationKey, conv] of Object.entries(manifest.conversations)) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }
    if (!conv.storeArtifact) {
      continue;
    }
    const storeEntry = manifest.artifacts[conv.storeArtifact];
    const swk = storeEntry?.sourceWorkspaceKey;
    if (typeof swk === "string" && swk.length > 0) {
      keys.add(swk);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export function deriveStoreWorkspaceMapping(
  manifest: TranscriptManifestV2,
  selectedConversationKeys: Set<string>,
  projectMapping: ReadonlyMap<string, ProjectInfo>
): { resolved: Map<string, string>; ambiguousSources: string[] } {
  const targetsBySource = new Map<string, Set<string>>();
  for (const [conversationKey, conv] of Object.entries(manifest.conversations)) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }
    if (!conv.storeArtifact) {
      continue;
    }
    const storeEntry = manifest.artifacts[conv.storeArtifact];
    const swk = storeEntry?.sourceWorkspaceKey;
    if (typeof swk !== "string" || swk.length === 0) {
      continue;
    }
    const tp = projectMapping.get(conv.projectKey);
    if (!tp) {
      continue;
    }
    const set = targetsBySource.get(swk) ?? new Set<string>();
    set.add(tp.folderName);
    targetsBySource.set(swk, set);
  }
  const resolved = new Map<string, string>();
  const ambiguousSources: string[] = [];
  for (const [swk, set] of [...targetsBySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size === 1) {
      resolved.set(swk, [...set][0]!);
    } else {
      ambiguousSources.push(swk);
    }
  }
  return { resolved, ambiguousSources };
}

export async function listChatsWorkspaceKeys(): Promise<string[]> {
  const root = resolveChatsRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function isSafeWorkspaceKeySegment(key: string): boolean {
  if (key.length === 0 || key === "." || key === "..") return false;
  if (key.includes("/") || key.includes("\\") || key.includes("\0")) return false;
  return true;
}

export async function promptForWorkspaceMapping(
  sourceWorkspaceKeys: string[],
  chatsWorkspaceKeys: string[],
  logger: ReturnType<typeof getLogger>
): Promise<Map<string, string> | null> {
  if (sourceWorkspaceKeys.length === 0) {
    return new Map();
  }

  const mapping = new Map<string, string>();

  for (const src of sourceWorkspaceKeys) {
    const picks: vscode.QuickPickItem[] = [
      ...chatsWorkspaceKeys.map((k) => ({ label: k, description: k })),
      { label: "Enter custom workspace key…", description: "__custom__" },
    ];
    picks.unshift({ label: "(Cancel import)", description: "__cancel__" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source chats workspace "${src}" to a local ~/.cursor/chats subdirectory`,
      placeHolder: "Select the destination workspace key for store.db restoration",
    });

    if (!selected || selected.description === "__cancel__") {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript import cancelled during workspace mapping`
      );
      return null;
    }

    if (selected.description === "__custom__") {
      const raw = await vscode.window.showInputBox({
        prompt: `Target workspace key for source "${src}" (single directory name under ~/.cursor/chats/)`,
        validateInput: (v) => {
          if (!v || !isSafeWorkspaceKeySegment(v.trim())) {
            return "Use one non-empty path segment without slashes.";
          }
          return undefined;
        },
      });
      if (raw === undefined) {
        return null;
      }
      mapping.set(src, raw.trim());
    } else if (selected.description) {
      mapping.set(src, selected.description);
    }
  }

  return mapping;
}
