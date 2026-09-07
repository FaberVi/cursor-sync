import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";

const MAX_BACKUPS = 3;

export interface BackupEntry {
  absolutePath: string;
  backupPath: string;
}

export interface DirectoryRestore {
  absolutePath: string;
  backupPath: string;
}

export function pathIsInsideDirectory(absPath: string, dir: string): boolean {
  const resolvedPath = path.resolve(absPath);
  const resolvedDir = path.resolve(dir);
  if (resolvedPath === resolvedDir) {
    return true;
  }
  const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
  if (process.platform === "win32") {
    return resolvedPath.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return resolvedPath.startsWith(prefix);
}

export function createBackupDirectory(context: vscode.ExtensionContext): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(context.globalStorageUri.fsPath, "backups", timestamp);
}

export async function createBackup(
  context: vscode.ExtensionContext,
  filePaths: string[],
  existingBackupDir?: string
): Promise<{ backupDir: string; entries: BackupEntry[] }> {
  if (filePaths.length === 0) {
    return { backupDir: existingBackupDir ?? "", entries: [] };
  }

  const backupDir = existingBackupDir ?? createBackupDirectory(context);
  await fs.mkdir(backupDir, { recursive: true });

  const entries: BackupEntry[] = [];

  for (const absPath of filePaths) {
    try {
      await fs.access(absPath);
      const relative = absPath.replace(/[/\\]/g, "--");
      const backupPath = path.join(backupDir, relative);
      await fs.copyFile(absPath, backupPath);
      entries.push({ absolutePath: absPath, backupPath });
    } catch {
      // File doesn't exist yet, no backup needed
    }
  }

  return { backupDir, entries };
}

/**
 * Recursive copy of existing skill folders for Mirror wipe rollback.
 * Missing local dirs are skipped (nothing to restore).
 */
export async function backupSkillDirectories(
  absDirs: string[],
  backupDir: string
): Promise<DirectoryRestore[]> {
  const directoryRestores: DirectoryRestore[] = [];
  if (absDirs.length === 0) {
    return directoryRestores;
  }
  await fs.mkdir(backupDir, { recursive: true });
  for (const absDir of absDirs) {
    const resolved = path.resolve(absDir);
    try {
      const st = await fs.lstat(resolved);
      if (!st.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const dest = path.join(
      backupDir,
      "skill-folders",
      path.resolve(absDir).replace(/[<>:"/\\|?*]/g, "--")
    );
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(resolved, dest, { recursive: true });
    directoryRestores.push({ absolutePath: resolved, backupPath: dest });
  }
  return directoryRestores;
}

/** Replace-restore: rm live dir then copy backup tree back. */
export async function restoreSkillDirectories(
  restores: DirectoryRestore[]
): Promise<DirectoryRestore[]> {
  const logger = getLogger();
  const restored: DirectoryRestore[] = [];
  for (const entry of restores) {
    try {
      await fs.rm(entry.absolutePath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(entry.absolutePath), { recursive: true });
      await fs.cp(entry.backupPath, entry.absolutePath, { recursive: true });
      restored.push(entry);
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Skill-folder rollback failed for ${entry.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return restored;
}

/** Ensures the parent directory exists and is writable (replaces broken symlinks/junctions). */
export async function ensureParentDirectory(absolutePath: string): Promise<void> {
  const dir = path.dirname(absolutePath);
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) {
      try {
        const followed = await fs.stat(dir);
        if (followed.isDirectory()) {
          return;
        }
      } catch {
        // Broken symlink/junction: replace with a real directory.
      }
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      return;
    }
    if (stat.isDirectory()) {
      return;
    }
    await fs.unlink(dir);
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await fs.mkdir(dir, { recursive: true });
      return;
    }
    throw err;
  }
}

export async function rollbackFromBackup(entries: BackupEntry[]): Promise<void> {
  const logger = getLogger();
  for (const entry of entries) {
    try {
      await ensureParentDirectory(entry.absolutePath);
      await fs.copyFile(entry.backupPath, entry.absolutePath);
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Rollback failed for ${entry.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await unlinkIfExists(`${entry.absolutePath}.tmp`);
  }
}

/** Remove files created in this run (no pre-existing backup) and leftover `.tmp` writes. */
export async function unlinkCreatedFiles(paths: string[]): Promise<number> {
  let removed = 0;
  for (const absPath of paths) {
    const deleted = await unlinkIfExists(absPath);
    await unlinkIfExists(`${absPath}.tmp`);
    if (deleted) {
      removed += 1;
    }
  }
  return removed;
}

async function unlinkIfExists(absPath: string): Promise<boolean> {
  try {
    await fs.unlink(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function pruneOldBackups(
  context: vscode.ExtensionContext
): Promise<void> {
  const backupsRoot = path.join(context.globalStorageUri.fsPath, "backups");

  let dirs: string[];
  try {
    dirs = await fs.readdir(backupsRoot);
  } catch {
    return;
  }

  dirs.sort();

  if (dirs.length <= MAX_BACKUPS) {
    return;
  }

  const toDelete = dirs.slice(0, dirs.length - MAX_BACKUPS);
  for (const dir of toDelete) {
    try {
      await fs.rm(path.join(backupsRoot, dir), { recursive: true, force: true });
    } catch {}
  }
}
