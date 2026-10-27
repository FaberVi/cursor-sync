import { isToggleOffPreservedSyncKey } from "./paths.js";
import { isConflictExcludedKey } from "./sync-conflicts.js";
import type { ConflictEntry } from "./types.js";
import type { PullReplacePlan } from "./sync-copy.js";
import { keyUnderSkillPrefix, skillFolderPrefix } from "./sync-skill-folders.js";

const LEGACY_CHAT_BUNDLES_KEY = "dot-cursor/chat-bundles.json";

function isExcludedDeletionKey(syncKey: string): boolean {
  return isConflictExcludedKey(syncKey) || syncKey === LEGACY_CHAT_BUNDLES_KEY;
}

export function detectIntentionalDeletions(input: {
  localChecksums: Record<string, string>;
  pendingDeletions?: readonly string[];
  localHashes: Record<string, string>;
  localKeys?: readonly string[];
  cloneChecksums: Record<string, string>;
}): string[] {
  const pending = input.pendingDeletions ?? [];
  const present = new Set(input.localKeys ?? []);
  const candidates = new Set<string>([
    ...Object.keys(input.localChecksums),
    ...pending,
  ]);
  const selected: string[] = [];
  for (const key of candidates) {
    if (isExcludedDeletionKey(key)) {
      continue;
    }
    if (present.has(key) || Object.prototype.hasOwnProperty.call(input.localHashes, key)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(input.cloneChecksums, key)) {
      continue;
    }
    selected.push(key);
  }
  return [...new Set(selected)].sort();
}

/** Skill folder, or the parent directory of any other synced file. */
export function folderPrefixForDeletion(syncKey: string): string | undefined {
  const skill = skillFolderPrefix(syncKey);
  if (skill) {
    return skill;
  }
  const slash = syncKey.lastIndexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  return syncKey.slice(0, slash);
}

/**
 * Prefixes whose every previously synced file is gone and no enumerated local
 * file remains. A new clone file under one of these must not recreate the folder.
 */
export function deletionPrefixes(
  localKeys: readonly string[],
  deletionKeys: readonly string[]
): string[] {
  const prefixes = new Set<string>();
  for (const key of deletionKeys) {
    const prefix = folderPrefixForDeletion(key);
    if (!prefix) {
      continue;
    }
    const stillLocal = localKeys.some((local) => keyUnderSkillPrefix(local, prefix));
    if (!stillLocal) {
      prefixes.add(prefix);
    }
  }
  return [...prefixes].sort();
}

export function expandDeletions(
  cloneKeys: readonly string[],
  deletionKeys: readonly string[],
  prefixes: readonly string[]
): string[] {
  const out = new Set(deletionKeys);
  for (const key of cloneKeys) {
    if (isExcludedDeletionKey(key)) {
      continue;
    }
    if (prefixes.some((prefix) => keyUnderSkillPrefix(key, prefix))) {
      out.add(key);
    }
  }
  return [...out].sort();
}

export function resolveIntentionalDeletions(input: {
  resetToRemote: boolean;
  localChecksums: Record<string, string>;
  pendingDeletions?: readonly string[];
  localHashes: Record<string, string>;
  localKeys: readonly string[];
  cloneChecksums: Record<string, string>;
}): string[] {
  if (input.resetToRemote) {
    return [];
  }
  const detected = detectIntentionalDeletions(input);
  const prefixes = deletionPrefixes(input.localKeys, detected);
  return expandDeletions(Object.keys(input.cloneChecksums), detected, prefixes);
}

export function omitIntentionalDeletions(
  plan: PullReplacePlan,
  keys: readonly string[]
): PullReplacePlan {
  if (keys.length === 0) {
    return plan;
  }
  const omit = new Set(keys);
  return {
    ...plan,
    filesToWrite: plan.filesToWrite.filter((file) => !omit.has(file.syncKey)),
    skillReplace: plan.skillReplace.filter(
      (prefix) => !keys.some((key) => keyUnderSkillPrefix(key, prefix))
    ),
  };
}

export function withoutDeletionKeys(
  keys: readonly string[],
  deletionKeys: readonly string[]
): string[] {
  if (deletionKeys.length === 0) {
    return [...keys];
  }
  const omit = new Set(deletionKeys);
  return keys.filter((key) => !omit.has(key));
}

export function conflictsWithoutDeletions(
  conflicts: readonly ConflictEntry[],
  deletionKeys: readonly string[]
): ConflictEntry[] {
  if (deletionKeys.length === 0) {
    return [...conflicts];
  }
  const omit = new Set(deletionKeys);
  return conflicts.filter((row) => !omit.has(row.relativeSyncKey));
}

export function checksumsWithoutDeletions(
  checksums: Record<string, string>,
  keys: readonly string[]
): Record<string, string> {
  if (keys.length === 0) {
    return { ...checksums };
  }
  const omit = new Set(keys);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(checksums)) {
    if (!omit.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

export function pendingDeletionsAfterPush(input: {
  pending?: readonly string[];
  writtenChecksums: Record<string, string>;
  cloneChecksums: Record<string, string>;
}): string[] {
  return (input.pending ?? [])
    .filter((key) => {
      if (Object.prototype.hasOwnProperty.call(input.writtenChecksums, key)) {
        return false;
      }
      if (Object.prototype.hasOwnProperty.call(input.cloneChecksums, key)) {
        return true;
      }
      // hashCloneSyncFiles omits MCP keys while mcp.syncEnabled is off, but the
      // clone file is left in place. Keep the pending deletion until a later
      // push can actually remove it.
      return isToggleOffPreservedSyncKey(key);
    })
    .sort();
}
