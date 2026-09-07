import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  enumerateSyncFiles,
  isExcludedSyncKey,
  isSkillSyncArtifact,
  resolveSyncRoots,
  type SyncRoots,
} from "./paths.js";
import { syncKeyToAbsolutePath } from "./sync-local-deletes.js";

const DOT_PREFIX = "dot-cursor/";
const USER_PREFIX = "cursor-user/";

export type SkillFolderWipePlan = {
  replace: string[];
  deleteLocalOnly: string[];
};

export type SkillConflictWarning = {
  prefix: string;
  extraCount: number;
};

function stripSyncRoot(syncKey: string): { root: "dot-cursor" | "cursor-user"; rest: string } | undefined {
  if (syncKey.startsWith(DOT_PREFIX)) {
    return { root: "dot-cursor", rest: syncKey.slice(DOT_PREFIX.length) };
  }
  if (syncKey.startsWith(USER_PREFIX)) {
    return { root: "cursor-user", rest: syncKey.slice(USER_PREFIX.length) };
  }
  return undefined;
}

/**
 * Sync-key prefix of a live skill folder (`dot-cursor/skills/foo`), or undefined
 * for non-skills, artifacts, and malformed names.
 */
export function skillFolderPrefix(syncKey: string): string | undefined {
  const stripped = stripSyncRoot(syncKey);
  if (!stripped) {
    return undefined;
  }
  if (isSkillSyncArtifact(stripped.rest)) {
    return undefined;
  }
  const parts = stripped.rest.split("/").filter(Boolean);
  if (parts[0] !== "skills" || parts.length < 2) {
    return undefined;
  }
  const name = parts[1];
  if (!name || name === "." || name === "..") {
    return undefined;
  }
  return `${stripped.root}/skills/${name}`;
}

/** Exact folder match: `prefix` itself or `prefix/...`, never `prefix-workspace`. */
export function keyUnderSkillPrefix(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}/`);
}

export function skillFolderDisplayName(prefix: string): string {
  const parts = prefix.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? prefix;
}

export function skillFolderAbsolutePath(
  prefix: string,
  roots: { cursorUser: string; dotCursor: string }
): string | undefined {
  const dummy = syncKeyToAbsolutePath(`${prefix}/SKILL.md`, roots);
  return dummy ? path.dirname(dummy) : undefined;
}

/**
 * True only for `{cursorUser|dotCursor}/skills/{name}` — never the sync roots
 * or the `skills/` parent.
 */
export function isSafeSkillFolderPath(
  absDir: string,
  roots: { cursorUser: string; dotCursor: string }
): boolean {
  const resolved = path.resolve(absDir);
  const userRoot = path.resolve(roots.cursorUser);
  const dotRoot = path.resolve(roots.dotCursor);
  if (resolved === userRoot || resolved === dotRoot) {
    return false;
  }
  const parent = path.resolve(path.dirname(resolved));
  const skillsUser = path.resolve(userRoot, "skills");
  const skillsDot = path.resolve(dotRoot, "skills");
  if (parent !== skillsUser && parent !== skillsDot) {
    return false;
  }
  const name = path.basename(resolved);
  return Boolean(name) && name !== "." && name !== "..";
}

export function planSkillFolderWipes(options: {
  remoteKeys: readonly string[];
  localKeys: readonly string[];
  keepLocalKeys: ReadonlySet<string>;
}): SkillFolderWipePlan {
  const keepPrefixes = new Set<string>();
  for (const key of options.keepLocalKeys) {
    const prefix = skillFolderPrefix(key);
    if (prefix) {
      keepPrefixes.add(prefix);
    }
  }

  const remotePrefixes = new Set<string>();
  for (const key of options.remoteKeys) {
    const prefix = skillFolderPrefix(key);
    if (prefix) {
      remotePrefixes.add(prefix);
    }
  }

  const localPrefixes = new Set<string>();
  for (const key of options.localKeys) {
    const prefix = skillFolderPrefix(key);
    if (prefix) {
      localPrefixes.add(prefix);
    }
  }

  const replace: string[] = [];
  for (const prefix of remotePrefixes) {
    if (!keepPrefixes.has(prefix)) {
      replace.push(prefix);
    }
  }

  const deleteLocalOnly: string[] = [];
  for (const prefix of localPrefixes) {
    if (remotePrefixes.has(prefix) || keepPrefixes.has(prefix)) {
      continue;
    }
    deleteLocalOnly.push(prefix);
  }

  return {
    replace: replace.sort(),
    deleteLocalOnly: deleteLocalOnly.sort(),
  };
}

export function keysCoveredBySkillFolders(
  keys: readonly string[],
  prefixes: readonly string[]
): string[] {
  if (prefixes.length === 0) {
    return [];
  }
  return keys.filter((key) => prefixes.some((prefix) => keyUnderSkillPrefix(key, prefix)));
}

export function missingRemoteSkillFiles(options: {
  replacePrefixes: readonly string[];
  remoteKeys: readonly string[];
  remoteFileNames: ReadonlySet<string>;
  syncKeyToGistFileName: (syncKey: string) => string;
}): string[] {
  if (options.replacePrefixes.length === 0) {
    return [];
  }
  const missing: string[] = [];
  for (const key of options.remoteKeys) {
    if (!options.replacePrefixes.some((prefix) => keyUnderSkillPrefix(key, prefix))) {
      continue;
    }
    if (skillFolderPrefix(key) === undefined) {
      continue;
    }
    if (isExcludedSyncKey(key)) {
      continue;
    }
    const gistName = options.syncKeyToGistFileName(key);
    if (!options.remoteFileNames.has(gistName)) {
      missing.push(key);
    }
  }
  return missing.sort();
}

export function skillConflictExtraLocalFiles(options: {
  conflicts: readonly { relativeSyncKey: string }[];
  localSkillFileKeys: readonly string[];
}): SkillConflictWarning[] {
  const conflictKeys = new Set(options.conflicts.map((c) => c.relativeSyncKey));
  const prefixes = new Set<string>();
  for (const conflict of options.conflicts) {
    const prefix = skillFolderPrefix(conflict.relativeSyncKey);
    if (prefix) {
      prefixes.add(prefix);
    }
  }

  const warnings: SkillConflictWarning[] = [];
  for (const prefix of [...prefixes].sort()) {
    const extras = new Set<string>();
    for (const key of options.localSkillFileKeys) {
      if (!keyUnderSkillPrefix(key, prefix)) {
        continue;
      }
      if (conflictKeys.has(key)) {
        continue;
      }
      extras.add(key);
    }
    if (extras.size > 0) {
      warnings.push({ prefix, extraCount: extras.size });
    }
  }
  return warnings;
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

export async function collectSkillConflictWarnings(
  conflicts: readonly { relativeSyncKey: string }[],
  roots?: SyncRoots
): Promise<SkillConflictWarning[]> {
  if (conflicts.length === 0) {
    return [];
  }
  const prefixes = [
    ...new Set(
      conflicts
        .map((c) => skillFolderPrefix(c.relativeSyncKey))
        .filter((p): p is string => Boolean(p))
    ),
  ];
  if (prefixes.length === 0) {
    return [];
  }

  const resolved = roots ?? resolveSyncRoots();
  const localKeys = new Set<string>();

  const enumerated = await enumerateSyncFiles(resolved);
  for (const entry of enumerated) {
    if (prefixes.some((prefix) => keyUnderSkillPrefix(entry.relativeSyncKey, prefix))) {
      localKeys.add(entry.relativeSyncKey);
    }
  }

  for (const prefix of prefixes) {
    const abs = skillFolderAbsolutePath(prefix, resolved);
    if (!abs) {
      continue;
    }
    const rels = await listFilesRelativePosix(abs);
    for (const rel of rels) {
      localKeys.add(`${prefix}/${rel}`);
    }
  }

  return skillConflictExtraLocalFiles({
    conflicts,
    localSkillFileKeys: [...localKeys],
  });
}
