import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildChatsKeyToFolderMap,
  md5FolderKey,
} from "./chat-workspace-context.js";
import { formatDisplayPath, projectGroupSidebarLabel } from "./chat-workspace-label.js";
import { chatIdentityKey } from "./chat-identity.js";
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
  storeSizeBytes?: number;
  storeMtimeMs?: number;
  transcriptMtimeMs?: number;
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
  storeSizeBytes?: number;
  storeMtimeMs?: number;
  transcriptMtimeMs?: number;
}

export function resolveProjectsRoot(): string {
  const { dotCursor } = resolveSyncRoots();
  return path.join(dotCursor, "projects");
}

export function discoveryMapKey(workspaceKey: string, conversationId: string): string {
  return workspaceKey ? `${workspaceKey}\0${conversationId}` : conversationId;
}

export function discoveryMapHasConversation(
  map: Map<string, MutableDiscovered>,
  conversationId: string
): boolean {
  if (map.has(conversationId)) {
    return true;
  }
  const suffix = `\0${conversationId}`;
  for (const key of map.keys()) {
    if (key.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function applyDiscoveryPatch(
  existing: MutableDiscovered,
  patch: {
    workspaceKey?: string;
    projectKey?: string;
    hasStore?: boolean;
    jsonlCount?: number;
    subagentJsonlCount?: number;
    storeSizeBytes?: number;
    storeMtimeMs?: number;
    transcriptMtimeMs?: number;
    source: ConversationSource;
  }
): void {
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
  if (typeof patch.storeSizeBytes === "number") {
    existing.storeSizeBytes = Math.max(existing.storeSizeBytes ?? 0, patch.storeSizeBytes);
  }
  if (typeof patch.storeMtimeMs === "number") {
    existing.storeMtimeMs = Math.max(existing.storeMtimeMs ?? 0, patch.storeMtimeMs);
  }
  if (typeof patch.transcriptMtimeMs === "number") {
    existing.transcriptMtimeMs = Math.max(
      existing.transcriptMtimeMs ?? 0,
      patch.transcriptMtimeMs
    );
  }
  const workspaceKey = patch.workspaceKey ?? "";
  const projectKey = patch.projectKey ?? "";
  if (!existing.workspaceKey && workspaceKey) {
    existing.workspaceKey = workspaceKey;
  }
  if (!existing.projectKey && projectKey) {
    existing.projectKey = projectKey;
  }
  existing.sources.add(patch.source);
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
    storeSizeBytes?: number;
    storeMtimeMs?: number;
    transcriptMtimeMs?: number;
    source: ConversationSource;
  }
): void {
  if (!CHAT_ID_RE.test(conversationId)) {
    return;
  }
  const workspaceKey = patch.workspaceKey ?? "";
  const projectKey = patch.projectKey ?? "";
  const key = discoveryMapKey(workspaceKey, conversationId);

  let existing = map.get(key);
  if (!existing && workspaceKey) {
    const idOnly = map.get(conversationId);
    if (idOnly) {
      map.delete(conversationId);
      idOnly.workspaceKey = workspaceKey;
      map.set(key, idOnly);
      existing = idOnly;
    }
  }
  if (!existing && !workspaceKey) {
    const composites = [...map.values()].filter(
      (entry) => entry.conversationId === conversationId && entry.workspaceKey
    );
    if (composites.length > 0) {
      for (const entry of composites) {
        applyDiscoveryPatch(entry, patch);
      }
      return;
    }
  }
  if (existing) {
    applyDiscoveryPatch(existing, patch);
    return;
  }
  map.set(key, {
    conversationId,
    workspaceKey,
    projectKey,
    hasStore: patch.hasStore ?? false,
    jsonlCount: patch.jsonlCount ?? 0,
    subagentJsonlCount: patch.subagentJsonlCount ?? 0,
    sources: new Set([patch.source]),
    storeSizeBytes: patch.storeSizeBytes,
    storeMtimeMs: patch.storeMtimeMs,
    transcriptMtimeMs: patch.transcriptMtimeMs,
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
      storeSizeBytes: entry.storeSizeBytes,
      storeMtimeMs: entry.storeMtimeMs,
      transcriptMtimeMs: entry.transcriptMtimeMs,
    }))
    .sort((a, b) => {
      const idCmp = a.conversationId.localeCompare(b.conversationId);
      if (idCmp !== 0) {
        return idCmp;
      }
      return a.workspaceKey.localeCompare(b.workspaceKey);
    });
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

export async function collectLocalChatIdentities(): Promise<Set<string>> {
  const discovered = await discoverBackupEligibleConversations();
  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const identities = new Set<string>();
  for (const d of discovered) {
    const folder = d.workspaceKey ? folderMap.get(d.workspaceKey) : undefined;
    const tilde = folder ? formatDisplayPath(folder) : "";
    identities.add(chatIdentityKey(tilde, d.conversationId));
  }
  return identities;
}

/** @deprecated Use {@link collectLocalChatIdentities} (composite tilde+id keys). */
export async function collectLocalConversationIds(): Promise<Set<string>> {
  return collectLocalChatIdentities();
}
