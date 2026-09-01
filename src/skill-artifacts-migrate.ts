import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { getToken } from "./auth.js";
import { getLogger, loadSyncState, saveSyncState } from "./diagnostics.js";
import { packageFiles } from "./packaging.js";
import {
  isSkillArtifactSegment,
  listSkillArtifactSyncKeys,
  resolveSyncRoots,
  syncKeyToGistFileName,
} from "./paths.js";
import { createRemoteBackend } from "./remote/factory.js";
import { readDestinationSettings } from "./remote/destination.js";
import type { Manifest } from "./types.js";
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
export async function purgeRemoteSkillArtifacts(
  context: vscode.ExtensionContext,
  migration?: SkillArtifactMigrationResult
): Promise<number> {
  const logger = getLogger();
  const token = await getToken(context);
  if (!token) {
    return 0;
  }

  const destSettings = readDestinationSettings();
  if (destSettings.type === "repo" && !destSettings.repo) {
    return 0;
  }

  const syncState = await loadSyncState(context);
  const backend = createRemoteBackend(context, token, syncState);
  if (!backend) {
    return 0;
  }

  const snapshotResult = await backend.getSnapshot({
    onlyFiles: ["manifest.json"],
  });
  if (!snapshotResult.ok) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skill artifact remote purge skipped: ${snapshotResult.error.message}`
    );
    return 0;
  }

  const manifestContent = snapshotResult.data.files["manifest.json"];
  if (!manifestContent) {
    return 0;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestContent) as Manifest;
  } catch {
    logger.appendLine(
      `[${new Date().toISOString()}] Skill artifact remote purge skipped: invalid manifest`
    );
    return 0;
  }

  const artifactKeys = listSkillArtifactSyncKeys(manifest.files);
  const dotCursorRoot = resolveSyncRoots().dotCursor;
  const recoveredDirs = migration?.recoveredSkillDirs ?? [];
  const skillEntries = await collectSkillFileEntries(dotCursorRoot, recoveredDirs);
  const { packaged, manifest: recoveredManifest, skipped } = await packageFiles(
    skillEntries,
    manifest.syncProfileName || "default"
  );

  if (skipped.length > 0) {
    for (const item of skipped) {
      logger.appendLine(
        `[${new Date().toISOString()}] Skill artifact remote purge skip file: ${item.relativeSyncKey} (${item.reason})`
      );
    }
  }

  if (artifactKeys.length === 0 && packaged.size === 0) {
    return 0;
  }

  const files = { ...manifest.files };
  for (const key of artifactKeys) {
    delete files[key];
  }
  for (const [key, entry] of Object.entries(recoveredManifest.files)) {
    files[key] = entry;
  }

  const nextManifest: Manifest = {
    ...manifest,
    createdAt: new Date().toISOString(),
    files,
  };

  const remoteFiles: Record<string, string> = {
    "manifest.json": JSON.stringify(nextManifest, null, 2),
  };
  for (const [syncKey, packagedFile] of packaged) {
    remoteFiles[syncKeyToGistFileName(syncKey)] = packagedFile.content;
  }

  const deleteNames = artifactKeys.map(syncKeyToGistFileName);
  const writeResult = await backend.writeFiles(remoteFiles, { deleteNames });
  if (!writeResult.ok) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skill artifact remote purge failed: ${writeResult.error.message}`
    );
    return 0;
  }

  if (syncState) {
    const localChecksums = { ...syncState.localChecksums };
    const artifactSet = new Set(artifactKeys);
    for (const key of Object.keys(localChecksums)) {
      if (artifactSet.has(key)) {
        delete localChecksums[key];
      }
    }
    for (const [key, entry] of packaged) {
      localChecksums[key] = entry.checksum;
    }
    const remoteChecksums: Record<string, string> = {};
    for (const [key, entry] of Object.entries(files)) {
      remoteChecksums[key] = entry.checksum;
    }
    await saveSyncState(context, {
      ...syncState,
      localChecksums,
      remoteChecksums,
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: writeResult.data.id || syncState.gistId,
    });
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Skill artifact remote purge: removed ${artifactKeys.length} artifact file(s), published ${packaged.size} recovered file(s)`
  );
  return artifactKeys.length + packaged.size;
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
