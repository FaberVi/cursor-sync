import { writeAtomicFile } from "./atomic-file-write.js";
import { getLogger } from "./diagnostics.js";
import { resolveSyncRoots, type SyncRoots } from "./paths.js";
import { syncKeyToAbsolutePath } from "./sync-local-deletes.js";
import {
  indexCloneSyncFiles,
  readCloneBuffer,
  readCloneManifest,
  resolveCloneAbs,
} from "./sync-copy.js";
import {
  isSafeSkillFolderPath,
  isVacantSkillDirectory,
  keyUnderSkillPrefix,
  skillFolderAbsolutePath,
  skillFolderPrefix,
} from "./sync-skill-folders.js";
import { ensureParentDirectory } from "./rollback.js";

/**
 * Copy clone skill files back into a local skill directory that exists but
 * has no files. A missing directory stays missing (the user removed the skill).
 * An empty shell must not be pushed as a deletion of the clone copy.
 */
export async function restoreVacantSkillFoldersFromClone(options: {
  clonePath: string;
  basePath: string;
  roots?: SyncRoots;
}): Promise<string[]> {
  const roots = options.roots ?? resolveSyncRoots();
  const index = await indexCloneSyncFiles(options.clonePath, options.basePath);
  const manifest = await readCloneManifest(options.clonePath, options.basePath);
  const byPrefix = new Map<string, string[]>();
  for (const key of index.nested.keys()) {
    const prefix = skillFolderPrefix(key);
    if (!prefix) {
      continue;
    }
    const keys = byPrefix.get(prefix) ?? [];
    keys.push(key);
    byPrefix.set(prefix, keys);
  }

  const restored: string[] = [];
  for (const [prefix, keys] of byPrefix) {
    const skillDir = skillFolderAbsolutePath(prefix, roots);
    if (!skillDir || !isSafeSkillFolderPath(skillDir, roots)) {
      continue;
    }
    if (!(await isVacantSkillDirectory(skillDir))) {
      continue;
    }
    for (const key of keys.sort()) {
      if (!keyUnderSkillPrefix(key, prefix)) {
        continue;
      }
      const cloneAbs = resolveCloneAbs(index, key);
      const localAbs = syncKeyToAbsolutePath(key, roots);
      if (!cloneAbs || !localAbs) {
        continue;
      }
      const content = await readCloneBuffer(cloneAbs, key, manifest);
      await writeAtomicFile(localAbs, content, ensureParentDirectory);
      restored.push(key);
    }
  }

  if (restored.length > 0) {
    getLogger().appendLine(
      `[${new Date().toISOString()}] Restored ${restored.length} file(s) into empty skill folders from the clone`
    );
  }
  return restored.sort();
}
