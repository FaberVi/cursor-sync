import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildChatsKeyToFolderMap,
  md5FolderKey,
  scanWorkspaceStorageForFolder,
  stateDbPathForWorkspaceStorageId,
} from "./chat-workspace-context.js";
import {
  getComposerId,
  parseComposerHeadersBlob,
} from "./composer-merge.js";
import {
  loadComposerNameIndexForChatsWorkspaceKey,
  loadGlobalComposerNameIndex,
  resolveComposerConversationTitle,
} from "./composer-title.js";
import { projectGroupSidebarLabel } from "./chat-workspace-label.js";
import { resolveSyncRoots } from "./paths.js";
import {
  discoverProjects,
  enumerateTranscriptFilesInConversation,
  findProjectMatchingOpenWorkspaceFolder,
  type ProjectInfo,
} from "./transcripts-discovery.js";
import { findWorkspaceKeysForConversation } from "./transcripts-cursor-paths.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import {
  summarizeDiscoveredBackupTier,
  type BackupTier,
  type LocalDiskKvProbe,
} from "./chat-backup-eligibility.js";

const CHAT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRANSCRIPT_SCAN_MAX_BYTES = 256 * 1024 * 1024;

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

function countSubagentJsonlFiles(
  files: Array<{ relativePath: string }>
): number {
  return files.filter((f) => f.relativePath.includes("/subagents/")).length;
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

export interface ConversationProjectGroup {
  projectKey: string;
  label: string;
  pathHint?: string;
  isCurrentWorkspace: boolean;
  conversations: DiscoveredConversation[];
}

interface MutableDiscovered {
  conversationId: string;
  workspaceKey: string;
  projectKey: string;
  hasStore: boolean;
  jsonlCount: number;
  subagentJsonlCount: number;
  sources: Set<ConversationSource>;
}

function resolveChatsRoot(): string {
  return __chatPersistenceInternals.resolveChatsRoot();
}

function resolveProjectsRoot(): string {
  const { dotCursor } = resolveSyncRoots();
  return path.join(dotCursor, "projects");
}

function upsertConversation(
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

function workspaceKeyFromHeaderRecord(
  record: Record<string, unknown>,
  folderMap: Map<string, string>
): string | undefined {
  const wi = record.workspaceIdentifier;
  if (!wi || typeof wi !== "object" || Array.isArray(wi)) {
    return undefined;
  }
  const uri = (wi as Record<string, unknown>).uri;
  if (uri && typeof uri === "object" && !Array.isArray(uri)) {
    const fsPath = (uri as Record<string, unknown>).fsPath;
    if (typeof fsPath === "string" && fsPath.length > 0) {
      return md5FolderKey(path.resolve(fsPath));
    }
  }
  for (const [key, folder] of folderMap) {
    const storageId = (wi as Record<string, unknown>).id;
    if (typeof storageId === "string" && storageId.length > 0) {
      const folderForKey = folderMap.get(key);
      if (!folderForKey) {
        continue;
      }
    }
  }
  return undefined;
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

async function discoverFromStoreDb(
  map: Map<string, MutableDiscovered>,
  chatsRoot: string,
  workspaceKeyFilter?: string
): Promise<void> {
  let workspaceEntries: import("node:fs").Dirent[];
  try {
    workspaceEntries = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }
    const workspaceKey = workspaceEntry.name;
    if (workspaceKeyFilter && workspaceKey !== workspaceKeyFilter) {
      continue;
    }
    const workspacePath = path.join(chatsRoot, workspaceKey);
    let convEntries: import("node:fs").Dirent[];
    try {
      convEntries = await fs.readdir(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const convEntry of convEntries) {
      if (!convEntry.isDirectory()) {
        continue;
      }
      const storePath = path.join(workspacePath, convEntry.name, "store.db");
      try {
        const stat = await fs.stat(storePath);
        if (!stat.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      upsertConversation(map, convEntry.name, {
        workspaceKey,
        hasStore: true,
        source: "disk",
      });
    }
  }
}

async function discoverFromTranscripts(
  map: Map<string, MutableDiscovered>,
  projectsRoot: string,
  options: {
    workspaceKeyFilter?: string;
    projectFolderName?: string;
  } = {}
): Promise<void> {
  const projects = await discoverProjects(projectsRoot);
  for (const project of projects) {
    if (
      options.projectFolderName &&
      project.folderName !== options.projectFolderName
    ) {
      continue;
    }
    const transcriptsDir = path.join(project.fullPath, "agent-transcripts");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      const conversationId = ent.name;
      const files = await enumerateTranscriptFilesInConversation(
        project.fullPath,
        conversationId,
        TRANSCRIPT_SCAN_MAX_BYTES
      );
      if (files.length === 0) {
        continue;
      }
      const keys = await findWorkspaceKeysForConversation(conversationId);
      const workspaceKey = keys[0] ?? "";
      if (
        options.workspaceKeyFilter &&
        workspaceKey &&
        workspaceKey !== options.workspaceKeyFilter
      ) {
        continue;
      }
      upsertConversation(map, conversationId, {
        workspaceKey,
        projectKey: project.folderName,
        jsonlCount: files.length,
        subagentJsonlCount: countSubagentJsonlFiles(files),
        hasStore: keys.length > 0,
        source: "transcript",
      });
    }
  }
}

async function discoverHeaderOnlyTranscriptDirs(
  map: Map<string, MutableDiscovered>,
  project: ProjectInfo
): Promise<void> {
  const transcriptsDir = path.join(project.fullPath, "agent-transcripts");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }
    const conversationId = ent.name;
    if (!CHAT_ID_RE.test(conversationId) || map.has(conversationId)) {
      continue;
    }
    const files = await enumerateTranscriptFilesInConversation(
      project.fullPath,
      conversationId,
      TRANSCRIPT_SCAN_MAX_BYTES
    );
    if (files.length > 0) {
      continue;
    }
    upsertConversation(map, conversationId, {
      projectKey: project.folderName,
      source: "header",
    });
  }
}

async function readComposerHeadersFromDb(
  dbPath: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await __chatPersistenceInternals.querySqliteRows(
      dbPath,
      "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1"
    );
    const raw = rows[0]?.value;
    if (typeof raw !== "string" || raw.length === 0) {
      return [];
    }
    return parseComposerHeadersBlob(raw).allComposers;
  } catch {
    return [];
  }
}

async function discoverFromComposerHeaders(
  map: Map<string, MutableDiscovered>,
  folderMap: Map<string, string>,
  options: {
    workspaceKeyFilter?: string;
    projectFolderName?: string;
    chatsKeyForProject?: string;
    projectKey?: string;
  } = {}
): Promise<void> {
  const { cursorUser } = resolveSyncRoots();

  if (!options.projectFolderName) {
    const globalDb = path.join(cursorUser, "globalStorage", "state.vscdb");
    const globalComposers = await readComposerHeadersFromDb(globalDb);
    for (const record of globalComposers) {
      const conversationId = getComposerId(record);
      if (!conversationId) {
        continue;
      }
      const workspaceKey =
        workspaceKeyFromHeaderRecord(record, folderMap) ??
        (await findWorkspaceKeysForConversation(conversationId))[0] ??
        "";
      if (
        options.workspaceKeyFilter &&
        workspaceKey &&
        workspaceKey !== options.workspaceKeyFilter
      ) {
        continue;
      }
      if (options.workspaceKeyFilter && !workspaceKey) {
        continue;
      }
      upsertConversation(map, conversationId, {
        workspaceKey,
        source: "header",
      });
    }
  }

  for (const [chatsKey, folderFsPath] of folderMap) {
    if (options.workspaceKeyFilter && chatsKey !== options.workspaceKeyFilter) {
      continue;
    }
    if (options.chatsKeyForProject && chatsKey !== options.chatsKeyForProject) {
      continue;
    }
    const storageId = await scanWorkspaceStorageForFolder(folderFsPath);
    if (!storageId) {
      continue;
    }
    const workspaceDb = stateDbPathForWorkspaceStorageId(storageId);
    const composers = await readComposerHeadersFromDb(workspaceDb);
    for (const record of composers) {
      const conversationId = getComposerId(record);
      if (!conversationId) {
        continue;
      }
      upsertConversation(map, conversationId, {
        workspaceKey: chatsKey,
        projectKey: options.projectKey,
        source: "header",
      });
    }
  }
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

export async function discoveredToExportRows(
  discovered: DiscoveredConversation[],
  options: {
    workspaceIndex?: Map<string, string>;
    globalIndex?: Map<string, string>;
    projectsRoot?: string;
    projectKey?: string;
    diskKvProbes?: Map<string, LocalDiskKvProbe>;
    probeDiskKv?: boolean;
  } = {}
): Promise<ConversationExportRow[]> {
  const projectsRoot = options.projectsRoot ?? resolveProjectsRoot();
  const globalIndex = options.globalIndex ?? (await loadGlobalComposerNameIndex());
  const rows: ConversationExportRow[] = [];
  for (const item of discovered) {
    const workspaceIndex =
      options.workspaceIndex ??
      (item.workspaceKey
        ? await loadComposerNameIndexForChatsWorkspaceKey(item.workspaceKey)
        : new Map<string, string>());
    let transcriptContent: string | null = null;
    const projectKey = item.projectKey ?? options.projectKey;
    if (item.jsonlCount > 0) {
      const projects = await discoverProjects(projectsRoot);
      const orderedProjects = projectKey
        ? projects.filter((p) => p.folderName === projectKey)
        : projects;
      for (const proj of orderedProjects) {
        const convDir = path.join(
          proj.fullPath,
          "agent-transcripts",
          item.conversationId
        );
        try {
          const files = await enumerateTranscriptFilesInConversation(
            proj.fullPath,
            item.conversationId,
            TRANSCRIPT_SCAN_MAX_BYTES
          );
          const preferred =
            files.find(
              (f) => path.basename(f.absolutePath, ".jsonl") === item.conversationId
            ) ?? files[0];
          if (!preferred) {
            continue;
          }
          transcriptContent = (
            await fs.readFile(preferred.absolutePath, "utf-8")
          ).toString();
          break;
        } catch {
          try {
            const dirFiles = await fs.readdir(convDir);
            const jsonl = dirFiles.find((f) => f.endsWith(".jsonl"));
            if (!jsonl) {
              continue;
            }
            transcriptContent = (
              await fs.readFile(path.join(convDir, jsonl), "utf-8")
            ).toString();
            break;
          } catch {
            continue;
          }
        }
      }
    }
    const title = await resolveComposerConversationTitle({
      conversationId: item.conversationId,
      chatsWorkspaceKey: item.workspaceKey || undefined,
      transcriptContent,
      workspaceIndex,
      globalIndex,
    });
    let diskKv =
      options.diskKvProbes?.get(item.conversationId) ?? null;
    if (options.probeDiskKv && !diskKv) {
      const { probeLocalDiskKv } = await import("./chat-disk-kv-export.js");
      diskKv = await probeLocalDiskKv(item.conversationId);
    }
    const tierSummary = summarizeDiscoveredBackupTier(item, diskKv);
    rows.push({
      conversationId: item.conversationId,
      label: title,
      description: item.conversationId,
      detail: tierSummary.detail,
      workspaceKey: item.workspaceKey || undefined,
      projectKey: item.projectKey || options.projectKey,
      hasStore: item.hasStore,
      jsonlCount: item.jsonlCount,
      subagentJsonlCount: item.subagentJsonlCount,
      backupTier: tierSummary.tier,
      backupTierLabel: tierSummary.label,
      fidelityWarnings:
        tierSummary.warnings.length > 0 ? tierSummary.warnings : undefined,
    });
  }
  return rows;
}

export async function collectLocalConversationIds(): Promise<Set<string>> {
  const discovered = await discoverBackupEligibleConversations();
  return new Set(discovered.map((d) => d.conversationId));
}
