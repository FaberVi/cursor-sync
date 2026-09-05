import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import {
  isSkillArtifactSegment,
  resolveSyncRoots,
} from "./paths.js";
import {
  collectSkillFileEntries,
  isDisposableSkillWorkspace,
  isSkillCreatorWorkspaceDir,
  mergeAllArtifactSources,
  mergeMissingFromSnapshot,
} from "./skill-artifact-promote.js";

export {
  findPromoteSource,
  isDisposableSkillWorkspace,
  isSkillCreatorWorkspaceDir,
  mergeMissingFromSnapshot,
} from "./skill-artifact-promote.js";

export interface SkillArtifactMigrationResult {
  promoted: Array<{ from: string; to: string }>;
  removed: string[];
  /** `skills/<name>` dirs that received recovered/merged content and must be published. */
  recoveredSkillDirs: string[];
}

/**
 * Promote skill-creator workspace snapshots to real skill folders and delete
 * disposable eval artifacts so Cursor no longer registers skills named
 * "skill-snapshot".
 *
 * Safety rules:
 * - Always merge-missing from artifact sources into the real skill before any rm.
 * - Always remove `skill-snapshot` / `skill-*-backup` dirs (Cursor names skills
 *   after the parent of SKILL.md — leaving those dirs registers "skill-snapshot").
 * - Only delete whole workspaces when disposable (artifact dirs only; no files
 *   at root, no iteration/eval/outputs/other dirs). Active forge workspaces keep
 *   iteration/eval trees and root files.
 * - Top-level `skills/skill-snapshot/` is relocated under
 *   `skills/_orphaned-snapshots/recovered-<ts>/`, never destroyed.
 */
export async function migrateSkillSyncArtifacts(
  dotCursorRoot: string
): Promise<SkillArtifactMigrationResult> {
  const promoted: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  const recoveredSkillDirs: string[] = [];
  const skillsRoot = path.join(dotCursorRoot, "skills");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return { promoted, removed, recoveredSkillDirs };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dirPath = path.join(skillsRoot, entry.name);
    const relDir = path.posix.join("skills", entry.name);

    if (isSkillArtifactSegment(entry.name)) {
      const recoveredRel = await relocateOrphanedArtifactDir(skillsRoot, entry.name);
      if (recoveredRel) {
        removed.push(relDir);
        recoveredSkillDirs.push(recoveredRel);
      }
      continue;
    }

    if (entry.name.endsWith("-workspace")) {
      if (!(await isSkillCreatorWorkspaceDir(dirPath))) {
        continue;
      }

      const baseName = entry.name.slice(0, -"-workspace".length);
      if (baseName) {
        const targetDir = path.join(skillsRoot, baseName);
        const targetRel = path.posix.join("skills", baseName);
        const mergedFrom = await mergeAllArtifactSources(dirPath, targetDir);
        for (const sourceName of mergedFrom) {
          promoted.push({
            from: path.posix.join(relDir, sourceName),
            to: targetRel,
          });
        }
        if (mergedFrom.length > 0) {
          recoveredSkillDirs.push(targetRel);
        }
      }

      if (await isDisposableSkillWorkspace(dirPath)) {
        await fs.rm(dirPath, { recursive: true, force: true });
        removed.push(relDir);
      } else {
        // Keep active forge workspaces (iteration-*, root files, fixtures), but
        // always strip snapshot/backup dirs so Cursor stops listing skill-snapshot.
        await removeArtifactSegmentDirs(dirPath, relDir, removed);
      }
      continue;
    }

    await removeNestedArtifactDirs(dirPath, relDir, removed, recoveredSkillDirs);
  }

  return {
    promoted,
    removed,
    recoveredSkillDirs: [...new Set(recoveredSkillDirs)],
  };
}

/** Run migration against the live `~/.cursor` root and log any changes. */
export async function migrateAndLogSkillArtifacts(
  dotCursorRoot?: string
): Promise<SkillArtifactMigrationResult> {
  const root = dotCursorRoot ?? resolveSyncRoots().dotCursor;
  const result = await migrateSkillSyncArtifacts(root);
  const logger = getLogger();

  if (
    result.promoted.length === 0 &&
    result.removed.length === 0 &&
    result.recoveredSkillDirs.length === 0
  ) {
    return result;
  }

  for (const item of result.promoted) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skill artifact migrate: promoted ${item.from} → ${item.to}`
    );
  }
  for (const rel of result.removed) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skill artifact migrate: removed ${rel}`
    );
  }
  for (const rel of result.recoveredSkillDirs) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skill artifact migrate: recovered ${rel}`
    );
  }
  logger.appendLine(
    `[${new Date().toISOString()}] Skill artifact migrate: ${result.promoted.length} promoted, ${result.removed.length} removed, ${result.recoveredSkillDirs.length} recovered`
  );

  return result;
}

/**
 * Publish recovered skill files and delete only skill-creator artifact keys
 * from the remote in one write. Never uploads unrelated settings.
 */
/**
 * Publish recovered skill files on the next Push (clone extra-delete).
 * Remote Git Data / Gist writes were removed in 2.0.
 */
export async function purgeRemoteSkillArtifacts(
  _context: vscode.ExtensionContext,
  _migration?: SkillArtifactMigrationResult
): Promise<number> {
  return 0;
}

async function removeArtifactSegmentDirs(
  parentDir: string,
  relParentDir: string,
  removed: string[]
): Promise<void> {
  let children: import("node:fs").Dirent[];
  try {
    children = await fs.readdir(parentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const child of children) {
    if (!child.isDirectory() || !isSkillArtifactSegment(child.name)) {
      continue;
    }
    const abs = path.join(parentDir, child.name);
    await fs.rm(abs, { recursive: true, force: true });
    removed.push(path.posix.join(relParentDir, child.name));
  }
}

async function removeNestedArtifactDirs(
  skillDir: string,
  relSkillDir: string,
  removed: string[],
  recoveredSkillDirs: string[]
): Promise<void> {
  let children: import("node:fs").Dirent[];
  try {
    children = await fs.readdir(skillDir, { withFileTypes: true });
  } catch {
    return;
  }

  let mergedAny = false;
  for (const child of children) {
    if (!child.isDirectory() || !isSkillArtifactSegment(child.name)) {
      continue;
    }
    const abs = path.join(skillDir, child.name);
    const copied = await mergeMissingFromSnapshot(abs, skillDir);
    if (copied > 0) {
      mergedAny = true;
    }
  }
  await removeArtifactSegmentDirs(skillDir, relSkillDir, removed);
  if (mergedAny) {
    recoveredSkillDirs.push(relSkillDir);
  }
}

/**
 * Move top-level artifact-named dirs (e.g. skills/skill-snapshot) to a unique
 * recovered path Cursor will not register as "skill-snapshot".
 */
async function relocateOrphanedArtifactDir(
  skillsRoot: string,
  entryName: string
): Promise<string | undefined> {
  const src = path.join(skillsRoot, entryName);
  const stamp = Date.now();
  const recoveredName = `recovered-${stamp}`;
  const recoveredRel = path.posix.join(
    "skills",
    "_orphaned-snapshots",
    recoveredName
  );
  const dest = path.join(skillsRoot, "_orphaned-snapshots", recoveredName);
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    return recoveredRel;
  } catch (err) {
    const logger = getLogger();
    const msg = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Skill artifact migrate: failed to relocate ${entryName}: ${msg}`
    );
    return undefined;
  }
}
