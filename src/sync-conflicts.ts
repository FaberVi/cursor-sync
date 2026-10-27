import { CURSOR_CHAT_SYNC_KEY } from "./chat-sync-collection.js";
import { isToggleOffPreservedSyncKey } from "./paths.js";
import type { PullReplacePlan } from "./sync-copy.js";
import type {
  ConflictEntry,
  ConflictKind,
  ConflictResolution,
  ResolvedConflict,
} from "./types.js";

function checksumOf(
  map: Record<string, string>,
  key: string
): string {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] ?? "" : "";
}

export function isConflictExcludedKey(key: string): boolean {
  return key === CURSOR_CHAT_SYNC_KEY || isToggleOffPreservedSyncKey(key);
}

export function conflictDisplayPath(syncKey: string): string {
  if (syncKey.startsWith("dot-cursor/")) {
    return syncKey.slice("dot-cursor/".length);
  }
  if (syncKey.startsWith("cursor-user/")) {
    return syncKey.slice("cursor-user/".length);
  }
  return syncKey;
}

export function classifyPullConflicts(input: {
  localChecksums: Record<string, string>;
  remoteChecksums: Record<string, string>;
  baseChecksums: Record<string, string>;
}): {
  conflicts: ConflictEntry[];
  autoKeepRemote: string[];
  autoKeepLocal: string[];
} {
  const keys = new Set([
    ...Object.keys(input.localChecksums),
    ...Object.keys(input.remoteChecksums),
    ...Object.keys(input.baseChecksums),
  ]);
  const conflicts: ConflictEntry[] = [];
  const autoKeepRemote: string[] = [];
  const autoKeepLocal: string[] = [];

  for (const key of [...keys].sort()) {
    if (isConflictExcludedKey(key)) {
      continue;
    }
    const local = checksumOf(input.localChecksums, key);
    const remote = checksumOf(input.remoteChecksums, key);
    const base = checksumOf(input.baseChecksums, key);

    if (local === remote) {
      continue;
    }

    if (!base) {
      if (local && remote) {
        conflicts.push(entry(key, local, remote, base, "bothModified"));
      } else if (local) {
        autoKeepLocal.push(key);
      } else if (remote) {
        autoKeepRemote.push(key);
      }
      continue;
    }

    const localChanged = local !== base;
    const remoteChanged = remote !== base;

    if (!localChanged && remoteChanged) {
      autoKeepRemote.push(key);
      continue;
    }
    if (localChanged && !remoteChanged) {
      autoKeepLocal.push(key);
      continue;
    }
    if (!localChanged && !remoteChanged) {
      continue;
    }

    let kind: ConflictKind = "bothModified";
    if (remote === "" && local !== "") {
      kind = "deletedRemote";
    } else if (local === "" && remote !== "") {
      kind = "deletedLocal";
    }
    conflicts.push(entry(key, local, remote, base, kind));
  }

  return { conflicts, autoKeepRemote, autoKeepLocal };
}

function entry(
  relativeSyncKey: string,
  localChecksum: string,
  remoteChecksum: string,
  baseChecksum: string,
  kind: ConflictKind
): ConflictEntry {
  return {
    relativeSyncKey,
    localChecksum,
    remoteChecksum,
    baseChecksum,
    kind,
  };
}

export function overlayPlanWithResolutions(
  plan: PullReplacePlan,
  resolutions: readonly ResolvedConflict[]
): PullReplacePlan {
  const keepLocal = new Set(
    resolutions
      .filter((row) => row.resolution === "keepLocal")
      .map((row) => row.relativeSyncKey)
  );
  if (keepLocal.size === 0) {
    return plan;
  }
  return {
    ...plan,
    filesToWrite: plan.filesToWrite.filter((file) => !keepLocal.has(file.syncKey)),
    keysToDelete: plan.keysToDelete.filter((key) => !keepLocal.has(key)),
  };
}

export function applyKeepLocalChecksums(
  checksums: Record<string, string>,
  previous: Record<string, string>,
  keepLocalKeys: readonly string[]
): Record<string, string> {
  const next = { ...checksums };
  for (const key of keepLocalKeys) {
    if (Object.prototype.hasOwnProperty.call(previous, key)) {
      next[key] = previous[key]!;
    } else {
      delete next[key];
    }
  }
  return next;
}

export function allConflictsResolved(
  conflicts: readonly ConflictEntry[],
  resolutions: Readonly<Record<string, ConflictResolution | undefined>>
): boolean {
  return conflicts.every((row) => {
    const chosen = resolutions[row.relativeSyncKey];
    return chosen === "keepLocal" || chosen === "keepRemote";
  });
}

export function resolutionsFromMap(
  conflicts: readonly ConflictEntry[],
  resolutions: Readonly<Record<string, ConflictResolution | undefined>>
): ResolvedConflict[] {
  return conflicts.map((row) => ({
    relativeSyncKey: row.relativeSyncKey,
    resolution: resolutions[row.relativeSyncKey] ?? "skip",
  }));
}

export function keepLocalKeysFromResolutions(
  resolutions: readonly ResolvedConflict[]
): string[] {
  return resolutions
    .filter((row) => row.resolution === "keepLocal")
    .map((row) => row.relativeSyncKey);
}
