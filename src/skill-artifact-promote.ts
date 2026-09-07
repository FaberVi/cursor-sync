import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSkillArtifactSegment } from "./paths.js";
import type { SyncFileEntry } from "./types.js";

/** True when dir looks like a skill-creator/skill-forge workspace. */
export async function isSkillCreatorWorkspaceDir(
  dirPath: string
): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (entry) =>
      entry.isDirectory() &&
      (isSkillArtifactSegment(entry.name) ||
        entry.name.startsWith("iteration-") ||
        entry.name.startsWith("eval-") ||
        entry.name === "outputs")
  );
}

/**
 * Disposable = only artifact snapshot/backup dirs (no active eval trees,
 * no loose files at workspace root).
 */
export async function isDisposableSkillWorkspace(
  dirPath: string
): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }

  let hasArtifact = false;
  for (const entry of entries) {
    if (entry.isFile()) {
      return false;
    }
    if (entry.isDirectory()) {
      if (isSkillArtifactSegment(entry.name)) {
        hasArtifact = true;
        continue;
      }
      return false;
    }
  }
  return hasArtifact;
}

/**
 * Among artifact dirs with SKILL.md, prefer the newest SKILL.md mtime
 * (recovers the most recent content when the live skill is incomplete/missing).
 */
export async function findPromoteSource(
  workspaceDir: string
): Promise<string | undefined> {
  const candidates = await listArtifactSourcesWithSkillMd(workspaceDir);
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.name;
}

export async function mergeAllArtifactSources(
  workspaceDir: string,
  targetDir: string
): Promise<string[]> {
  const candidates = await listArtifactSources(workspaceDir);
  // Newest first so the first file written for each path is the newest content.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const mergedFrom: string[] = [];
  for (const candidate of candidates) {
    const sourceDir = path.join(workspaceDir, candidate.name);
    const copied = await mergeMissingFromSnapshot(sourceDir, targetDir);
    if (copied > 0) {
      mergedFrom.push(candidate.name);
    }
  }
  return mergedFrom;
}

async function listArtifactSources(
  workspaceDir: string
): Promise<Array<{ name: string; mtimeMs: number }>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSkillArtifactSegment(entry.name)) {
      continue;
    }
    const abs = path.join(workspaceDir, entry.name);
    const skillMd = path.join(abs, "SKILL.md");
    let mtimeMs = 0;
    try {
      const st = await fs.stat((await pathExists(skillMd)) ? skillMd : abs);
      mtimeMs = st.mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    result.push({ name: entry.name, mtimeMs });
  }
  return result;
}

async function listArtifactSourcesWithSkillMd(
  workspaceDir: string
): Promise<Array<{ name: string; mtimeMs: number }>> {
  const all = await listArtifactSources(workspaceDir);
  const withSkill: Array<{ name: string; mtimeMs: number }> = [];
  for (const item of all) {
    const skillMd = path.join(workspaceDir, item.name, "SKILL.md");
    if (!(await pathExists(skillMd))) {
      continue;
    }
    try {
      const st = await fs.stat(skillMd);
      withSkill.push({ name: item.name, mtimeMs: st.mtimeMs });
    } catch {
      withSkill.push(item);
    }
  }
  return withSkill;
}

/** Copy only files that do not already exist at the destination. */
export async function mergeMissingFromSnapshot(
  srcDir: string,
  destDir: string
): Promise<number> {
  let copied = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  await fs.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += await mergeMissingFromSnapshot(src, dest);
    } else if (entry.isFile()) {
      if (!(await pathExists(dest))) {
        await fs.copyFile(src, dest);
        copied += 1;
      }
    }
  }
  return copied;
}

export async function collectSkillFileEntries(
  dotCursorRoot: string,
  skillDirs: string[]
): Promise<SyncFileEntry[]> {
  const entries: SyncFileEntry[] = [];
  for (const relDir of skillDirs) {
    const absDir = path.join(dotCursorRoot, ...relDir.split("/"));
    const files = await walkFiles(absDir);
    for (const absFile of files) {
      const relFile = path.relative(dotCursorRoot, absFile).split(path.sep).join("/");
      entries.push({
        absolutePath: absFile,
        relativeSyncKey: `dot-cursor/${relFile}`,
      });
    }
  }
  return entries;
}

async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkillArtifactSegment(entry.name)) {
        continue;
      }
      results.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
