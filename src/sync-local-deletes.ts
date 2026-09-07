import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { isExcludedSyncKey } from "./paths.js";
import { createBackup, type BackupEntry } from "./rollback.js";

export type LocalDeleteMode = "mirror" | "remoteRemoved";

/** Keep chat transport out of file wipe (D5); strings match chat-sync keys. */
const PROTECTED_SYNC_KEYS = new Set([
  "dot-cursor/cursor-chat.json",
  "dot-cursor/chat-bundles.json",
]);

export function isProtectedLocalDeleteKey(syncKey: string): boolean {
  if (PROTECTED_SYNC_KEYS.has(syncKey)) {
    return true;
  }
  return isExcludedSyncKey(syncKey);
}

/**
 * Plan local sync keys to delete.
 * - mirror: every local key absent from current remote (except keepLocal / protected)
 * - remoteRemoved: only keys that were on the previous remote and are gone now
 */
export function planLocalDeletes(options: {
  mode: LocalDeleteMode;
  localSyncKeys: string[];
  remoteChecksums: Record<string, string>;
  previousRemoteChecksums: Record<string, string>;
  keepLocalKeys: ReadonlySet<string>;
}): string[] {
  const remoteKeys = new Set(Object.keys(options.remoteChecksums));
  const planned: string[] = [];

  for (const key of options.localSyncKeys) {
    if (options.keepLocalKeys.has(key)) {
      continue;
    }
    if (isProtectedLocalDeleteKey(key)) {
      continue;
    }
    if (remoteKeys.has(key)) {
      continue;
    }

    if (options.mode === "mirror") {
      planned.push(key);
      continue;
    }

    // remoteRemoved: never-synced local-new must survive for push
    if (Object.prototype.hasOwnProperty.call(options.previousRemoteChecksums, key)) {
      planned.push(key);
    }
  }

  return planned.sort();
}

export async function pruneEmptyAncestors(
  startFilePath: string,
  stopRoots: string[]
): Promise<void> {
  const normalizedStops = new Set(stopRoots.map((r) => path.resolve(r)));
  let dir = path.dirname(path.resolve(startFilePath));

  while (dir && !normalizedStops.has(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    try {
      const entries = await fs.readdir(dir);
      if (entries.length > 0) {
        break;
      }
      await fs.rmdir(dir);
    } catch {
      break;
    }
    dir = parent;
  }
}

export function syncKeyToAbsolutePath(
  syncKey: string,
  roots: { cursorUser: string; dotCursor: string }
): string | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    const rel = syncKey.slice("cursor-user/".length);
    return path.join(roots.cursorUser, ...rel.split("/"));
  }
  if (syncKey.startsWith("dot-cursor/")) {
    const rel = syncKey.slice("dot-cursor/".length);
    return path.join(roots.dotCursor, ...rel.split("/"));
  }
  return undefined;
}

export interface ApplyLocalDeletesResult {
  deletedKeys: string[];
  backupEntries: BackupEntry[];
}

export class PartialLocalDeleteError extends Error {
  readonly deletedKeys: string[];
  readonly backupEntries: BackupEntry[];
  readonly failedKey: string;

  constructor(
    message: string,
    opts: {
      deletedKeys: string[];
      backupEntries: BackupEntry[];
      failedKey: string;
      cause?: unknown;
    }
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PartialLocalDeleteError";
    this.deletedKeys = opts.deletedKeys;
    this.backupEntries = opts.backupEntries;
    this.failedKey = opts.failedKey;
  }
}

/**
 * Backup then delete planned sync keys; prune empty parent dirs.
 * On mid-loop failure throws PartialLocalDeleteError with progress so callers can rollback.
 */
export async function applyLocalDeletes(
  context: vscode.ExtensionContext,
  syncKeys: string[],
  roots: { cursorUser: string; dotCursor: string },
  options?: { backupEntries?: BackupEntry[] }
): Promise<ApplyLocalDeletesResult> {
  const logger = getLogger();
  const absolutePaths: string[] = [];
  const keyToAbs = new Map<string, string>();

  for (const key of syncKeys) {
    const abs = syncKeyToAbsolutePath(key, roots);
    if (!abs) {
      continue;
    }
    keyToAbs.set(key, abs);
    absolutePaths.push(abs);
  }

  let backupEntries = options?.backupEntries ?? [];
  if (!options?.backupEntries && absolutePaths.length > 0) {
    const created = await createBackup(context, absolutePaths);
    backupEntries = created.entries;
  }

  const deletedKeys: string[] = [];
  const stopRoots = [roots.cursorUser, roots.dotCursor];

  for (const key of syncKeys) {
    const abs = keyToAbs.get(key);
    if (!abs) {
      continue;
    }
    try {
      await fs.rm(abs, { force: true });
      deletedKeys.push(key);
      await pruneEmptyAncestors(abs, stopRoots);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.appendLine(
        `[${new Date().toISOString()}] Failed to delete ${key} (${abs}): ${msg}`
      );
      throw new PartialLocalDeleteError(`Failed to delete ${key}: ${msg}`, {
        deletedKeys: [...deletedKeys],
        backupEntries,
        failedKey: key,
        cause: err,
      });
    }
  }

  return { deletedKeys, backupEntries };
}
