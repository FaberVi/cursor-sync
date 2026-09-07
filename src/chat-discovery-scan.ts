import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  md5FolderKey,
  scanWorkspaceStorageForFolder,
  stateDbPathForWorkspaceStorageId,
} from "./chat-workspace-context.js";
import { getComposerId, parseComposerHeadersBlob } from "./composer-merge.js";
import { resolveSyncRoots } from "./paths.js";
import {
  discoverProjects,
  enumerateTranscriptFilesInConversation,
  type ProjectInfo,
} from "./transcripts-discovery.js";
import { findWorkspaceKeysForConversation } from "./transcripts-cursor-paths.js";
import { querySqliteRows } from "./transcripts-sqlite.js";
import {
  CHAT_ID_RE,
  TRANSCRIPT_SCAN_MAX_BYTES,
  discoveryMapHasConversation,
  upsertConversation,
  type MutableDiscovered,
} from "./chat-discovery.js";

export function countSubagentJsonlFiles(
  files: Array<{ relativePath: string }>
): number {
  return files.filter((f) => f.relativePath.includes("/subagents/")).length;
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

async function readComposerHeadersFromDb(
  dbPath: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await querySqliteRows(
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

export async function discoverFromStoreDb(
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
        upsertConversation(map, convEntry.name, {
          workspaceKey,
          hasStore: true,
          storeSizeBytes: stat.size,
          storeMtimeMs: Math.trunc(stat.mtimeMs),
          source: "disk",
        });
      } catch {
        continue;
      }
    }
  }
}

export async function discoverFromTranscripts(
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
      let transcriptMtimeMs = 0;
      try {
        const tstat = await fs.stat(path.join(transcriptsDir, conversationId));
        transcriptMtimeMs = Math.trunc(tstat.mtimeMs);
      } catch {
        /* keep 0 */
      }
      const keys = await findWorkspaceKeysForConversation(conversationId);
      const workspaceKeys =
        keys.length > 0 ? keys : ([""] as string[]);
      for (const workspaceKey of workspaceKeys) {
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
          transcriptMtimeMs,
          source: "transcript",
        });
      }
    }
  }
}

export async function discoverHeaderOnlyTranscriptDirs(
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
    if (!CHAT_ID_RE.test(conversationId) || discoveryMapHasConversation(map, conversationId)) {
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

export async function discoverFromComposerHeaders(
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
