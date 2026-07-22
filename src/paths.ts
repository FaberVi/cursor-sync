import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import type { SyncFileEntry } from "./types.js";

export interface SyncRoots {
  cursorUser: string;
  dotCursor: string;
}

const DENYLIST_DIRS = [
  "extensions",
  "logs",
  "CachedData",
  "CachedExtensions",
  "CachedProfilesData",
  "Crashpad",
  "DawnCache",
  "GPUCache",
  "blob_storage",
  "Local Storage",
  "Session Storage",
  "Network",
  "shared_proto_db",
  "databases",
];

const DENYLIST_FILES = ["TransportSecurity"];

const DENYLIST_GLOBS = [
  "Cookies*",
  "*.db",
  "*.db-journal",
  "*.db-wal",
  "*.log",
  "*.pyc",
];

/** Path segments that must never be synced (matched anywhere in the relative path). */
const DENYLIST_PATH_SEGMENTS = ["__pycache__"];

/** skill-creator / skill-forge backup folder names (matched as path segments). */
const SKILL_BACKUP_SEGMENT_RE = /^skill-.+-backup$/;

const MAX_SYNC_VSIX_BYTES = 50 * 1024 * 1024;

/** True for skill-creator snapshot/backup directory names. */
export function isSkillArtifactSegment(name: string): boolean {
  return (
    name === "skill-snapshot" ||
    name.startsWith("skill-snapshot-") ||
    SKILL_BACKUP_SEGMENT_RE.test(name)
  );
}

function isSkillCreatorActivitySegment(name: string): boolean {
  return (
    name.startsWith("iteration-") ||
    name.startsWith("eval-") ||
    name === "outputs"
  );
}

/**
 * skill-creator/skill-forge eval workspaces nest SKILL.md under skill-snapshot/
 * (or skill-*-backup/). Cursor names skills after the immediate parent folder, so
 * syncing those artifacts registers bogus skills named "skill-snapshot".
 *
 * A legitimate skill whose folder name ends with `-workspace` (e.g.
 * `skills/my-agent-workspace/SKILL.md`) is still synced — only skill-creator
 * layouts (artifact / iteration / eval / outputs segments) are excluded.
 */
export function isSkillSyncArtifact(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts[0] !== "skills" || parts.length < 2) {
    return false;
  }

  if (parts.some((part) => isSkillArtifactSegment(part))) {
    return true;
  }

  // Top-level directory is itself an artifact name (bogus skill folder).
  if (isSkillArtifactSegment(parts[1]!)) {
    return true;
  }

  if (parts[1]!.endsWith("-workspace")) {
    return parts.some((part) => isSkillCreatorActivitySegment(part));
  }

  return false;
}

/**
 * True when a sync key must not be pushed or restored (hard denylist + user excludeGlobs).
 * Accepts full keys (`dot-cursor/skills/...`) or root-relative paths (`skills/...`).
 */
export function isExcludedSyncKey(
  syncKey: string,
  excludeGlobs?: string[]
): boolean {
  let rel = syncKey;
  if (rel.startsWith("dot-cursor/")) {
    rel = rel.slice("dot-cursor/".length);
  } else if (rel.startsWith("cursor-user/")) {
    rel = rel.slice("cursor-user/".length);
  }

  if (isDenylisted(rel) || isSkillSyncArtifact(rel)) {
    return true;
  }

  const globs =
    excludeGlobs ??
    vscode.workspace.getConfiguration("cursorSync").get<string[]>("excludeGlobs") ??
    [];
  return globs.some((g) => minimatch(rel, g));
}

/** Sync keys under `dot-cursor/skills/` that are skill-creator artifacts. */
export function listSkillArtifactSyncKeys(
  manifestFiles: Record<string, unknown>
): string[] {
  return Object.keys(manifestFiles).filter((key) => {
    if (!key.startsWith("dot-cursor/")) {
      return false;
    }
    return isSkillSyncArtifact(key.slice("dot-cursor/".length));
  });
}

export function resolveSyncRoots(
  platform: NodeJS.Platform = process.platform
): SyncRoots {
  if (platform === "win32") {
    const appData = process.env["APPDATA"] || path.join(os.homedir(), "AppData", "Roaming");
    const userProfile = process.env["USERPROFILE"] || os.homedir();
    return {
      cursorUser: path.join(appData, "Cursor", "User"),
      dotCursor: path.join(userProfile, ".cursor"),
    };
  }

  if (platform === "darwin") {
    const home = os.homedir();
    return {
      cursorUser: path.join(home, "Library", "Application Support", "Cursor", "User"),
      dotCursor: path.join(home, ".cursor"),
    };
  }

  const configHome = process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return {
    cursorUser: path.join(configHome, "Cursor", "User"),
    dotCursor: path.join(os.homedir(), ".cursor"),
  };
}

export async function enumerateSyncFiles(
  roots?: SyncRoots
): Promise<SyncFileEntry[]> {
  const resolved = roots ?? resolveSyncRoots();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const enabledPaths = config.get<string[]>("enabledPaths") ?? getDefaultEnabledPaths();
  const excludeGlobs = config.get<string[]>("excludeGlobs") ?? [];
  const maxFileSizeKB = config.get<number>("maxFileSizeKB") ?? 512;
  const maxBytes = maxFileSizeKB * 1024;

  const cursorUserGlobs = enabledPaths.filter(
    (g) =>
      g === "settings.json" ||
      g === "keybindings.json" ||
      g === "extensions.json" ||
      g.startsWith("snippets") ||
      g.startsWith("vsix")
  );
  const dotCursorGlobs = enabledPaths.filter(
    (g) =>
      g.startsWith("skills") ||
      g.startsWith("commands") ||
      g.startsWith("rules")
  );

  const entries: SyncFileEntry[] = [];

  await collectFiles(
    resolved.cursorUser,
    "cursor-user",
    cursorUserGlobs,
    excludeGlobs,
    maxBytes,
    entries
  );
  await collectFiles(
    resolved.dotCursor,
    "dot-cursor",
    dotCursorGlobs,
    excludeGlobs,
    maxBytes,
    entries
  );

  return entries.sort((a, b) => a.relativeSyncKey.localeCompare(b.relativeSyncKey));
}

async function collectFiles(
  rootDir: string,
  prefix: string,
  includeGlobs: string[],
  excludeGlobs: string[],
  maxBytes: number,
  result: SyncFileEntry[]
): Promise<void> {
  const exists = await dirExists(rootDir);
  if (!exists) {
    return;
  }

  const allFiles = await walkDirectory(rootDir);
  for (const absPath of allFiles) {
    const rel = path.relative(rootDir, absPath).split(path.sep).join("/");

    if (isDenylisted(rel)) {
      continue;
    }

    const matchesInclude = includeGlobs.some((g) => minimatch(rel, g));
    if (!matchesInclude) {
      continue;
    }

    const matchesExclude = excludeGlobs.some((g) => minimatch(rel, g));
    if (matchesExclude) {
      continue;
    }

    try {
      const stat = await fs.stat(absPath);
      const sizeLimit = rel.toLowerCase().endsWith(".vsix")
        ? MAX_SYNC_VSIX_BYTES
        : maxBytes;
      if (stat.size > sizeLimit) {
        continue;
      }
    } catch {
      continue;
    }

    result.push({
      absolutePath: absPath,
      relativeSyncKey: `${prefix}/${rel}`,
    });
  }
}

function isDenylisted(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const topDir = parts[0];

  if (topDir && DENYLIST_DIRS.includes(topDir)) {
    return true;
  }

  if (parts.some((part) => DENYLIST_PATH_SEGMENTS.includes(part))) {
    return true;
  }

  if (isSkillSyncArtifact(relativePath)) {
    return true;
  }

  const fileName = parts[parts.length - 1];
  if (fileName && DENYLIST_FILES.includes(fileName)) {
    return true;
  }

  if (fileName) {
    for (const glob of DENYLIST_GLOBS) {
      if (minimatch(fileName, glob)) {
        return true;
      }
    }
  }

  return false;
}

async function walkDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkDirectory(fullPath);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function getDefaultEnabledPaths(): string[] {
  return [
    "settings.json",
    "keybindings.json",
    "snippets/**",
    "extensions.json",
    "vsix/**",
    "skills/**",
    "skills-cursor/**/SKILL.md",
    "commands/**/*.md",
    "rules/*.mdc",
  ];
}

export function syncKeyToGistFileName(syncKey: string): string {
  return syncKey.replace(/\//g, "--");
}

export function gistFileNameToSyncKey(gistFileName: string): string {
  return gistFileName.replace(/--/g, "/");
}
