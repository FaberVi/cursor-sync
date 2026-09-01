import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildChatsKeyToFolderMap,
  md5FolderKey,
} from "./chat-workspace-context.js";
import { projectGroupSidebarLabel } from "./chat-workspace-label.js";
import { resolveSyncRoots } from "./paths.js";
import {
  discoverProjects,
  findProjectMatchingOpenWorkspaceFolder,
  type ProjectInfo,
} from "./transcripts-discovery.js";
import { findWorkspaceKeysForConversation, resolveChatsRoot } from "./transcripts-cursor-paths.js";
import type { BackupTier } from "./chat-backup-eligibility.js";
import {
  discoverFromComposerHeaders,
  discoverFromStoreDb,
  discoverFromTranscripts,
  discoverHeaderOnlyTranscriptDirs,
} from "./chat-discovery-scan.js";

export const CHAT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TRANSCRIPT_SCAN_MAX_BYTES = 256 * 1024 * 1024;

export type ConversationSource = "disk" | "transcript" | "header";

export interface ConversationExportRow {
  conversationId: string;
  label: string;
  description: string;
  detail: string;
  workspaceKey?: string;
  projectKey?: string;
  hasStore?: boolean;
  jsonlCount?: number;
  subagentJsonlCount?: number;
  backupTier?: BackupTier;
  backupTierLabel?: string;
  fidelityWarnings?: string[];
}

export interface DiscoveredConversation {
  conversationId: string;
  workspaceKey: string;
  projectKey?: string;
  hasStore: boolean;
  jsonlCount: number;
  subagentJsonlCount: number;
  sources: ConversationSource[];
}

export interface ConversationProjectGroup {
  projectKey: string;
  label: string;
  pathHint?: string;
  isCurrentWorkspace: boolean;
  conversations: DiscoveredConversation[];
}

export interface MutableDiscovered {
  conversationId: string;
  workspaceKey: string;
  projectKey: string;
  hasStore: boolean;
  jsonlCount: number;
  subagentJsonlCount: number;
  sources: Set<ConversationSource>;
}

export function resolveProjectsRoot(): string {
  const { dotCursor } = resolveSyncRoots();
  return path.join(dotCursor, "projects");
}

export function upsertConversation(
  map: Map<string, MutableDiscovered>,
  conversationId: string,
  patch: {
    workspaceKey?: string;
    projectKey?: string;
    hasStore?: boolean;
    jsonlCount?: number;
    subagentJsonlCount?: number;
    source: ConversationSource;
  }
): void {
  if (!CHAT_ID_RE.test(conversationId)) {
    return;
  }
  const workspaceKey = patch.workspaceKey ?? "";
  const projectKey = patch.projectKey ?? "";
  const existing = map.get(conversationId);
  if (existing) {
    if (patch.hasStore) {
      existing.hasStore = true;
    }
    if (typeof patch.jsonlCount === "number" && patch.jsonlCount > existing.jsonlCount) {
      existing.jsonlCount = patch.jsonlCount;
    }
    if (
      typeof patch.subagentJsonlCount === "number" &&
      patch.subagentJsonlCount > existing.subagentJsonlCount
    ) {
      existing.subagentJsonlCount = patch.subagentJsonlCount;
    }
    if (!existing.workspaceKey && workspaceKey) {
      existing.workspaceKey = workspaceKey;
    }
    if (!existing.projectKey && projectKey) {
      existing.projectKey = projectKey;
    }
    existing.sources.add(patch.source);
    return;
  }
  map.set(conversationId, {
    conversationId,
    workspaceKey,
    projectKey,
    hasStore: patch.hasStore ?? false,
    jsonlCount: patch.jsonlCount ?? 0,
    subagentJsonlCount: patch.subagentJsonlCount ?? 0,
    sources: new Set([patch.source]),
  });
}

/** On-disk data sufficient for `buildChatBundle` (store.db and/or transcript JSONL). */
export function isBackupEligibleConversation(
  item: Pick<DiscoveredConversation, "hasStore" | "jsonlCount">
): boolean {
  return item.hasStore || item.jsonlCount > 0;
}

export function filterBackupEligibleConversations<T extends DiscoveredConversation>(
  items: T[]
): T[] {
  return items.filter(isBackupEligibleConversation);
}

export async function discoverBackupEligibleConversations(): Promise<DiscoveredConversation[]> {
  return filterBackupEligibleConversations(await discoverAllConversations());
}

async function enrichStoreFlagsFromDisk(
  map: Map<string, MutableDiscovered>
): Promise<void> {
  for (const entry of map.values()) {
    if (entry.hasStore) {
      continue;
    }
    const keys = await findWorkspaceKeysForConversation(entry.conversationId);
    if (keys.length === 0) {
      continue;
    }
    entry.hasStore = true;
    if (!entry.workspaceKey) {
      entry.workspaceKey = keys[0]!;
    }
  }
}

function workspaceKeyForProject(
  project: ProjectInfo,
  folderMap: Map<string, string>
): string {
  for (const [chatsKey, folderFsPath] of folderMap) {
    const base = path.basename(folderFsPath).toLowerCase();
    const label = project.label.toLowerCase();
    if (base === label || project.folderName.toLowerCase().includes(base)) {
      return chatsKey;
    }
  }
  return "";
}

function finalizeDiscovered(map: Map<string, MutableDiscovered>): DiscoveredConversation[] {
  return [...map.values()]
    .map((entry) => ({
      conversationId: entry.conversationId,
      workspaceKey: entry.workspaceKey,
      projectKey: entry.projectKey || undefined,
      hasStore: entry.hasStore,
      jsonlCount: entry.jsonlCount,
      subagentJsonlCount: entry.subagentJsonlCount,
      sources: [...entry.sources].sort() as ConversationSource[],
    }))
    .sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}

export async function discoverAllConversations(): Promise<DiscoveredConversation[]> {
  const chatsRoot = resolveChatsRoot();
  const projectsRoot = resolveProjectsRoot();
  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const map = new Map<string, MutableDiscovered>();
  await discoverFromStoreDb(map, chatsRoot);
  await discoverFromTranscripts(map, projectsRoot);
  await discoverFromComposerHeaders(map, folderMap);
  return finalizeDiscovered(map);
}

export async function discoverConversationsForOpenWorkspace(): Promise<
  DiscoveredConversation[]
> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  const folder = folders[0];
  if (!folder) {
    return [];
  }
  const workspaceKeyFilter = md5FolderKey(path.resolve(folder.uri.fsPath));
  const projectsRoot = resolveProjectsRoot();
  const projects = await discoverProjects(projectsRoot);
  const currentProject = findProjectMatchingOpenWorkspaceFolder(projects, folders);

  const map = new Map<string, MutableDiscovered>();
  await discoverFromStoreDb(map, resolveChatsRoot(), workspaceKeyFilter);
  if (currentProject) {
    await discoverFromTranscripts(map, projectsRoot, {
      projectFolderName: currentProject.folderName,
    });
    const { cursorUser } = resolveSyncRoots();
    const folderMap = await buildChatsKeyToFolderMap(cursorUser);
    await discoverFromComposerHeaders(map, folderMap, {
      workspaceKeyFilter,
      chatsKeyForProject: workspaceKeyFilter,
      projectKey: currentProject.folderName,
    });
    await discoverHeaderOnlyTranscriptDirs(map, currentProject);
  } else {
    await discoverFromTranscripts(map, projectsRoot, { workspaceKeyFilter });
    const { cursorUser } = resolveSyncRoots();
    const folderMap = await buildChatsKeyToFolderMap(cursorUser);
    await discoverFromComposerHeaders(map, folderMap, { workspaceKeyFilter });
  }

  await enrichStoreFlagsFromDisk(map);

  return finalizeDiscovered(map);
}

export async function discoverConversationsGroupedByProject(): Promise<
  ConversationProjectGroup[]
> {
  const projectsRoot = resolveProjectsRoot();
  const projects = await discoverProjects(projectsRoot);
  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const currentProject = findProjectMatchingOpenWorkspaceFolder(projects);
  const chatsRoot = resolveChatsRoot();

  const groups: ConversationProjectGroup[] = [];

  for (const project of projects) {
    const map = new Map<string, MutableDiscovered>();
    const chatsKey = workspaceKeyForProject(project, folderMap);

    if (chatsKey) {
      await discoverFromStoreDb(map, chatsRoot, chatsKey);
    }

    await discoverFromTranscripts(map, projectsRoot, {
      projectFolderName: project.folderName,
    });

    if (chatsKey) {
      await discoverFromComposerHeaders(map, folderMap, {
        chatsKeyForProject: chatsKey,
        projectKey: project.folderName,
      });
    }

    await discoverHeaderOnlyTranscriptDirs(map, project);

    await enrichStoreFlagsFromDisk(map);

    const conversations = filterBackupEligibleConversations(finalizeDiscovered(map));
    if (conversations.length === 0) {
      continue;
    }

    const { label, pathHint } = projectGroupSidebarLabel(project.folderName, folderMap);
    groups.push({
      projectKey: project.folderName,
      label,
      pathHint,
      isCurrentWorkspace: currentProject?.folderName === project.folderName,
      conversations,
    });
  }

  return groups.sort((a, b) => {
    if (a.isCurrentWorkspace !== b.isCurrentWorkspace) {
      return a.isCurrentWorkspace ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
}

export { discoveredToExportRows } from "./chat-discovery-export.js";

export async function collectLocalConversationIds(): Promise<Set<string>> {
  const discovered = await discoverBackupEligibleConversations();
  return new Set(discovered.map((d) => d.conversationId));
}
