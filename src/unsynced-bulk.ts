import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  getDefaultEnabledPaths,
  includedRootDirectories,
  isMcpSyncEnabled,
  resolveSyncRoots,
  type SyncRoots,
} from "./paths.js";
import { t } from "./sidebar/i18n.js";

/** A top-level folder at or above this size is large enough to review before sync. */
export const BULK_FILE_MIN = 500;
const FILE_COUNT_CAP = 2_000;
const SKIP_SEGMENTS = new Set(["node_modules", ".git", "__pycache__"]);

export type UnsyncedBulkDir = {
  /** Root-relative label, for example `.cursor/skill-forge-workspaces`. */
  label: string;
  absolutePath: string;
  fileCount: number;
  capped: boolean;
};

let lastFound: UnsyncedBulkDir[] = [];

function syncedDirectoryNames(): Set<string> | undefined {
  const config = vscode.workspace.getConfiguration("cursorSync");
  let enabledPaths = config.get<string[]>("enabledPaths") ?? getDefaultEnabledPaths();
  if (isMcpSyncEnabled() && !enabledPaths.includes("mcp.json")) {
    enabledPaths = [...enabledPaths, "mcp.json"];
  }
  return includedRootDirectories(enabledPaths);
}

function fileCountLabel(fileCount: number, capped: boolean): string {
  if (capped) {
    return t("unsyncedBulkFileCountCapped", { n: fileCount });
  }
  if (fileCount === 1) {
    return t("unsyncedBulkFileCountOne", { n: fileCount });
  }
  return t("unsyncedBulkFileCount", { n: fileCount });
}

export function formatUnsyncedBulkList(
  dirs: readonly Pick<UnsyncedBulkDir, "label" | "fileCount" | "capped">[]
): string {
  return dirs
    .map((dir) => `${dir.label} (${fileCountLabel(dir.fileCount, dir.capped)})`)
    .join(", ");
}

export function getLastUnsyncedBulk(): readonly UnsyncedBulkDir[] {
  return lastFound;
}

async function countFilesCapped(
  dir: string,
  cap: number
): Promise<{ fileCount: number; capped: boolean }> {
  let fileCount = 0;
  const stack = [dir];
  while (stack.length > 0 && fileCount < cap) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (fileCount >= cap) {
        break;
      }
      if (entry.isSymbolicLink() || SKIP_SEGMENTS.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      } else if (entry.isFile()) {
        fileCount += 1;
      }
    }
  }
  return { fileCount, capped: fileCount >= cap };
}

export async function findUnsyncedBulkDirs(
  roots?: SyncRoots
): Promise<UnsyncedBulkDir[]> {
  const resolved = roots ?? resolveSyncRoots();
  const syncedNames = syncedDirectoryNames();
  const specs = [
    { abs: resolved.dotCursor, label: ".cursor" },
    { abs: resolved.cursorUser, label: "Cursor User" },
  ];
  const pending: Promise<UnsyncedBulkDir | undefined>[] = [];
  for (const spec of specs) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(spec.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (syncedNames?.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(spec.abs, entry.name);
      pending.push(
        countFilesCapped(absolutePath, FILE_COUNT_CAP).then((counted) => {
          if (counted.fileCount < BULK_FILE_MIN) {
            return undefined;
          }
          return {
            label: `${spec.label}/${entry.name}`,
            absolutePath,
            fileCount: counted.fileCount,
            capped: counted.capped,
          };
        })
      );
    }
  }
  const found = (await Promise.all(pending)).filter(
    (dir): dir is UnsyncedBulkDir => dir !== undefined
  );
  found.sort((left, right) => {
    if (right.fileCount !== left.fileCount) {
      return right.fileCount - left.fileCount;
    }
    return left.label.localeCompare(right.label);
  });
  lastFound = found;
  return found;
}

/** Manual sync and push ask before continuing. Scheduled sync does not. */
export async function confirmUnsyncedBulkProceed(
  trigger: "manual" | "scheduled" | "syncNow"
): Promise<boolean> {
  if (trigger === "scheduled") {
    return true;
  }
  const found = await findUnsyncedBulkDirs();
  if (found.length === 0) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    t("unsyncedBulkConfirm", {
      min: BULK_FILE_MIN,
      names: formatUnsyncedBulkList(found),
    }),
    { modal: true },
    t("proceed")
  );
  return choice === t("proceed");
}

export async function revealUnsyncedBulk(): Promise<void> {
  const found = lastFound.length > 0 ? lastFound : await findUnsyncedBulkDirs();
  if (found.length === 0) {
    return;
  }
  let chosen = found[0];
  if (found.length > 1) {
    const pick = await vscode.window.showQuickPick(
      found.map((dir) => ({
        label: dir.label,
        description: fileCountLabel(dir.fileCount, dir.capped),
        dir,
      })),
      { placeHolder: t("unsyncedBulkPick") }
    );
    if (!pick) {
      return;
    }
    chosen = pick.dir;
  }
  if (!chosen) {
    return;
  }
  await vscode.commands.executeCommand(
    "revealFileInOS",
    vscode.Uri.file(chosen.absolutePath)
  );
}
