import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { Manifest, ManifestFileEntry } from "./types.js";
import { computeChecksum, computeMachineId } from "./packaging.js";
import {
  enumerateSyncFiles,
  gistFileNameToSyncKey,
  isToggleOffPreservedSyncKey,
  resolveSyncRoots,
  type SyncRoots,
} from "./paths.js";
import { isLegacyDashedRelative, joinRemotePath } from "./remote/path-map.js";
import { syncKeyToAbsolutePath, planLocalDeletes, applyLocalDeletes } from "./sync-local-deletes.js";
import {
  isSafeSkillFolderPath,
  keysCoveredBySkillFolders,
  planSkillFolderWipes,
  skillFolderAbsolutePath,
} from "./sync-skill-folders.js";
import {
  backupSkillDirectories,
  createBackup,
  createBackupDirectory,
  ensureParentDirectory,
  pruneOldBackups,
  type BackupEntry,
  type DirectoryRestore,
} from "./rollback.js";
import { throwIfAborted } from "./sync-abort.js";
import { CURSOR_CHAT_GIST_FILE_NAME } from "./chat-bundle-format.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import { CURSOR_CHAT_SYNC_KEY } from "./chat-sync-collection.js";
import { isChatSyncEnabled } from "./chat-sync.js";

const MANIFEST_NAME = "manifest.json";
const SPECIAL_ROOT_FILES = new Set([
  MANIFEST_NAME,
  CURSOR_CHAT_GIST_FILE_NAME,
  CHAT_BUNDLES_GIST_FILE_NAME,
]);

export function cloneBaseAbs(clonePath: string, basePath: string): string {
  return path.join(clonePath, ...basePath.split("/").filter(Boolean));
}

export function cloneAbsForSyncKey(
  clonePath: string,
  basePath: string,
  syncKey: string
): string {
  return path.join(cloneBaseAbs(clonePath, basePath), ...syncKey.split("/"));
}

export function cloneChatAbs(clonePath: string, basePath: string): string {
  return path.join(cloneBaseAbs(clonePath, basePath), CURSOR_CHAT_GIST_FILE_NAME);
}

export function cloneManifestAbs(clonePath: string, basePath: string): string {
  return path.join(cloneBaseAbs(clonePath, basePath), MANIFEST_NAME);
}

async function writeAtomic(absPath: string, content: Buffer): Promise<void> {
  await ensureParentDirectory(absPath);
  const tmp = `${absPath}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, absPath);
}

async function listFilesRelativePosix(absDir: string): Promise<string[]> {
  const resolvedRoot = path.resolve(absDir);
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = path.relative(resolvedRoot, fullPath).split(path.sep).join("/");
        if (!rel || rel.startsWith("..")) {
          continue;
        }
        files.push(rel);
      }
    }
  }

  await walk(resolvedRoot);
  return files;
}

export type CloneFileIndex = {
  /** Nested layout wins: cursor-user/settings.json */
  nested: Map<string, string>;
  /** Leftover dashed at basePath root: cursor-user--settings.json */
  dashed: Map<string, string>;
  special: Map<string, string>;
};

export async function indexCloneSyncFiles(
  clonePath: string,
  basePath: string
): Promise<CloneFileIndex> {
  const baseAbs = cloneBaseAbs(clonePath, basePath);
  const nested = new Map<string, string>();
  const dashed = new Map<string, string>();
  const special = new Map<string, string>();
  const rels = await listFilesRelativePosix(baseAbs);

  for (const rel of rels) {
    const abs = path.join(baseAbs, ...rel.split("/"));
    if (!rel.includes("/")) {
      if (SPECIAL_ROOT_FILES.has(rel)) {
        special.set(rel, abs);
        continue;
      }
      if (isLegacyDashedRelative(rel)) {
        dashed.set(gistFileNameToSyncKey(rel), abs);
        continue;
      }
      continue;
    }
    nested.set(rel, abs);
  }

  return { nested, dashed, special };
}

/** Nested path wins over leftover dashed for the same sync key. */
export function resolveCloneAbs(index: CloneFileIndex, syncKey: string): string | undefined {
  return index.nested.get(syncKey) ?? index.dashed.get(syncKey);
}

export async function readCloneManifest(
  clonePath: string,
  basePath: string
): Promise<Manifest | undefined> {
  try {
    const raw = await fs.readFile(cloneManifestAbs(clonePath, basePath), "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return undefined;
  }
}

export async function readCloneBuffer(
  absPath: string,
  syncKey: string,
  manifest: Manifest | undefined
): Promise<Buffer> {
  const buf = await fs.readFile(absPath);
  const encoding = manifest?.files[syncKey]?.encoding;
  if (encoding === "base64") {
    const asText = buf.toString("utf8").replace(/\s+/g, "");
    return Buffer.from(asText, "base64");
  }
  return buf;
}

export async function readCloneChatRaw(
  clonePath: string,
  basePath: string
): Promise<string | undefined> {
  const index = await indexCloneSyncFiles(clonePath, basePath);
  const native = index.special.get(CURSOR_CHAT_GIST_FILE_NAME);
  const legacy = index.special.get(CHAT_BUNDLES_GIST_FILE_NAME);
  const abs = native ?? legacy;
  if (!abs) {
    return undefined;
  }
  return fs.readFile(abs, "utf8");
}

export async function hashCursorSyncFiles(
  roots?: SyncRoots
): Promise<Record<string, string>> {
  const entries = await enumerateSyncFiles(roots);
  const out: Record<string, string> = {};
  for (const entry of entries) {
    try {
      const buf = await fs.readFile(entry.absolutePath);
      out[entry.relativeSyncKey] = computeChecksum(buf);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

export async function hashCloneSyncFiles(
  clonePath: string,
  basePath: string
): Promise<Record<string, string>> {
  const index = await indexCloneSyncFiles(clonePath, basePath);
  const manifest = await readCloneManifest(clonePath, basePath);
  const keys = new Set([...index.nested.keys(), ...index.dashed.keys()]);
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key === CURSOR_CHAT_SYNC_KEY || isToggleOffPreservedSyncKey(key)) {
      continue;
    }
    const abs = resolveCloneAbs(index, key);
    if (!abs) {
      continue;
    }
    try {
      const buf = await readCloneBuffer(abs, key, manifest);
      out[key] = computeChecksum(buf);
    } catch {
      // skip
    }
  }
  return out;
}

export function syncKeysDiffer(
  local: Record<string, string>,
  clone: Record<string, string>
): boolean {
  const keys = new Set([...Object.keys(local), ...Object.keys(clone)]);
  for (const key of keys) {
    if (local[key] !== clone[key]) {
      return true;
    }
  }
  return false;
}

export type CursorToCloneResult = {
  writtenKeys: string[];
  checksums: Record<string, string>;
};

export function withChatCollectionChecksum(
  checksums: Record<string, string>,
  chatRaw: string | undefined
): Record<string, string> {
  if (chatRaw === undefined) {
    return checksums;
  }
  return {
    ...checksums,
    [CURSOR_CHAT_SYNC_KEY]: computeChecksum(Buffer.from(chatRaw, "utf8")),
  };
}

export async function copyCursorToClone(options: {
  clonePath: string;
  basePath: string;
  /** UTF-8 chat collection to write at basePath/cursor-chat.json. Omit to leave an existing file. */
  chatContent?: string;
  profileName: string;
}): Promise<CursorToCloneResult> {
  throwIfAborted();
  const roots = resolveSyncRoots();
  const entries = await enumerateSyncFiles(roots);
  const keepRel = new Set<string>();
  const checksums: Record<string, string> = {};
  const writtenKeys: string[] = [];
  const manifestFiles: Record<string, ManifestFileEntry> = {};

  for (const entry of entries) {
    throwIfAborted();
    const buf = await fs.readFile(entry.absolutePath);
    const dest = cloneAbsForSyncKey(options.clonePath, options.basePath, entry.relativeSyncKey);
    await writeAtomic(dest, buf);
    const checksum = computeChecksum(buf);
    checksums[entry.relativeSyncKey] = checksum;
    writtenKeys.push(entry.relativeSyncKey);
    keepRel.add(entry.relativeSyncKey);
    manifestFiles[entry.relativeSyncKey] = {
      checksum,
      sizeBytes: buf.length,
    };
  }

  if (options.chatContent !== undefined) {
    const chatAbs = cloneChatAbs(options.clonePath, options.basePath);
    const chatBuf = Buffer.from(options.chatContent, "utf8");
    await writeAtomic(chatAbs, chatBuf);
    keepRel.add(CURSOR_CHAT_GIST_FILE_NAME);
    checksums[CURSOR_CHAT_SYNC_KEY] = computeChecksum(chatBuf);
  }

  const manifest: Manifest = {
    schemaVersion: 1,
    syncProfileName: options.profileName,
    createdAt: new Date().toISOString(),
    sourceMachineId: computeMachineId(),
    sourceOS: process.platform as Manifest["sourceOS"],
    files: manifestFiles,
  };
  await writeAtomic(
    cloneManifestAbs(options.clonePath, options.basePath),
    Buffer.from(JSON.stringify(manifest, null, 2), "utf8")
  );
  keepRel.add(MANIFEST_NAME);

  const index = await indexCloneSyncFiles(options.clonePath, options.basePath);
  const toDelete: string[] = [];
  for (const [key, abs] of index.nested) {
    if (!keepRel.has(key) && !isToggleOffPreservedSyncKey(key)) {
      toDelete.push(abs);
    }
  }
  for (const abs of index.dashed.values()) {
    toDelete.push(abs);
  }
  for (const [name, abs] of index.special) {
    if (name === MANIFEST_NAME) {
      continue;
    }
    if (name === CURSOR_CHAT_GIST_FILE_NAME) {
      continue;
    }
    if (name === CHAT_BUNDLES_GIST_FILE_NAME) {
      toDelete.push(abs);
    }
  }

  for (const abs of toDelete) {
    await fs.rm(abs, { force: true });
  }

  return { writtenKeys, checksums };
}

export type PullReplacePlan = {
  filesToWrite: Array<{
    syncKey: string;
    absolutePath: string;
    content: Buffer;
  }>;
  keysToDelete: string[];
  skillReplace: string[];
  skillDeleteLocalOnly: string[];
  remoteChecksums: Record<string, string>;
  chatRaw?: string;
};

export async function planCloneToCursor(
  clonePath: string,
  basePath: string
): Promise<PullReplacePlan> {
  const roots = resolveSyncRoots();
  const localEntries = await enumerateSyncFiles(roots);
  const localSyncKeys = localEntries.map((e) => e.relativeSyncKey);
  const index = await indexCloneSyncFiles(clonePath, basePath);
  const manifest = await readCloneManifest(clonePath, basePath);
  const remoteChecksums = await hashCloneSyncFiles(clonePath, basePath);

  const remoteKeys = [...new Set([...index.nested.keys(), ...index.dashed.keys()])];
  const folderPlan = planSkillFolderWipes({
    remoteKeys,
    localKeys: localSyncKeys,
    keepLocalKeys: new Set(),
  });
  const wipePrefixes = [...folderPlan.replace, ...folderPlan.deleteLocalOnly];

  const localHashes = await hashCursorSyncFiles(roots);
  const filesToWrite: PullReplacePlan["filesToWrite"] = [];
  for (const key of remoteKeys) {
    if (key === CURSOR_CHAT_SYNC_KEY || isToggleOffPreservedSyncKey(key)) {
      continue;
    }
    const abs = resolveCloneAbs(index, key);
    if (!abs) {
      continue;
    }
    const cursorAbs = syncKeyToAbsolutePath(key, roots);
    if (!cursorAbs) {
      continue;
    }
    const content = await readCloneBuffer(abs, key, manifest);
    const underReplace = folderPlan.replace.some((prefix) =>
      key === prefix || key.startsWith(`${prefix}/`)
    );
    if (!underReplace && localHashes[key] === computeChecksum(content)) {
      continue;
    }
    filesToWrite.push({ syncKey: key, absolutePath: cursorAbs, content });
  }

  const rawKeysToDelete = planLocalDeletes({
    mode: "mirror",
    localSyncKeys,
    remoteChecksums,
    previousRemoteChecksums: {},
    keepLocalKeys: new Set(),
  });
  const coveredDeletes = new Set(keysCoveredBySkillFolders(rawKeysToDelete, wipePrefixes));
  const keysToDelete = rawKeysToDelete.filter((key) => !coveredDeletes.has(key));

  const chatRaw = isChatSyncEnabled()
    ? await readCloneChatRaw(clonePath, basePath)
    : undefined;

  return {
    filesToWrite,
    keysToDelete,
    skillReplace: folderPlan.replace,
    skillDeleteLocalOnly: folderPlan.deleteLocalOnly,
    remoteChecksums,
    chatRaw,
  };
}

export type ApplyCloneToCursorResult = {
  writtenKeys: string[];
  deletedKeys: string[];
  checksums: Record<string, string>;
  backupEntries: BackupEntry[];
  createdPaths: string[];
  directoryRestores: DirectoryRestore[];
};

export async function applyCloneToCursor(
  context: vscode.ExtensionContext,
  plan: PullReplacePlan
): Promise<ApplyCloneToCursorResult> {
  throwIfAborted();
  const roots = resolveSyncRoots();
  const wipePrefixes = [...plan.skillReplace, ...plan.skillDeleteLocalOnly];
  const wipeAbs = wipePrefixes
    .map((prefix) => skillFolderAbsolutePath(prefix, roots))
    .filter((p): p is string => typeof p === "string" && isSafeSkillFolderPath(p, roots));

  const backupDir = createBackupDirectory(context);
  const writePaths = plan.filesToWrite.map((f) => f.absolutePath);
  const deletePaths = plan.keysToDelete
    .map((key) => syncKeyToAbsolutePath(key, roots))
    .filter((p): p is string => Boolean(p));
  const { entries: backupEntries } = await createBackup(
    context,
    [...writePaths, ...deletePaths],
    backupDir
  );
  const directoryRestores = await backupSkillDirectories(wipeAbs, backupDir);

  const createdPaths: string[] = [];
  const writtenKeys: string[] = [];
  const checksums: Record<string, string> = { ...plan.remoteChecksums };

  for (const abs of wipeAbs) {
    throwIfAborted();
    await fs.rm(abs, { recursive: true, force: true });
  }

  for (const file of plan.filesToWrite) {
    throwIfAborted();
    let existed = true;
    try {
      await fs.access(file.absolutePath);
    } catch {
      existed = false;
    }
    await writeAtomic(file.absolutePath, file.content);
    if (!existed) {
      createdPaths.push(file.absolutePath);
    }
    writtenKeys.push(file.syncKey);
    checksums[file.syncKey] = computeChecksum(file.content);
  }

  const deleteResult = await applyLocalDeletes(context, plan.keysToDelete, roots, {
    backupEntries: [],
  });

  await pruneOldBackups(context);

  return {
    writtenKeys,
    deletedKeys: deleteResult.deletedKeys,
    checksums,
    backupEntries,
    createdPaths,
    directoryRestores,
  };
}

export function pullConfirmCounts(plan: PullReplacePlan): {
  n: number;
  m: number;
  k: number;
} {
  return {
    n: plan.filesToWrite.length,
    m: plan.keysToDelete.length,
    k: plan.skillReplace.length + plan.skillDeleteLocalOnly.length,
  };
}
