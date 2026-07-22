import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import type {
  SyncState,
  ConflictEntry,
  ResolvedConflict,
  ConflictResolution,
} from "./types.js";
import { computeChecksum } from "./packaging.js";
import { enumerateSyncFiles } from "./paths.js";
import { loadSyncState } from "./diagnostics.js";
import { getLogger } from "./diagnostics.js";
import { ensureExtensionsJsonOnDisk } from "./extensions.js";

const PENDING_RESOLUTIONS_KEY = "cursorSync.pendingConflictResolutions";

let pendingResolutions: ResolvedConflict[] = [];
let pendingConflicts: ConflictEntry[] = [];
let resolutionsContext: vscode.ExtensionContext | undefined;

export function getPendingConflicts(): ConflictEntry[] {
  return pendingConflicts;
}

export function getPendingResolutions(): ResolvedConflict[] {
  return pendingResolutions;
}

export function getUnresolvedConflicts(
  conflicts: ConflictEntry[]
): ConflictEntry[] {
  return conflicts.filter((c) => {
    const resolution = getResolutionForKey(c.relativeSyncKey);
    return !resolution || resolution === "skip";
  });
}

export async function loadPendingResolutions(
  context: vscode.ExtensionContext
): Promise<void> {
  resolutionsContext = context;
  const stored = context.globalState.get<ResolvedConflict[]>(
    PENDING_RESOLUTIONS_KEY
  );
  if (Array.isArray(stored)) {
    pendingResolutions = stored.filter(
      (entry) =>
        entry &&
        typeof entry.relativeSyncKey === "string" &&
        (entry.resolution === "keepLocal" ||
          entry.resolution === "keepRemote" ||
          entry.resolution === "skip")
    );
  }
}

async function persistPendingResolutions(): Promise<void> {
  if (!resolutionsContext) {
    return;
  }
  await resolutionsContext.globalState.update(
    PENDING_RESOLUTIONS_KEY,
    pendingResolutions
  );
}

export async function clearConflicts(): Promise<void> {
  pendingConflicts = [];
  pendingResolutions = [];
  await persistPendingResolutions();
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.hasConflicts",
    false
  );
}

export async function computeLocalChecksums(): Promise<Record<string, string>> {
  await ensureExtensionsJsonOnDisk();
  const localFiles = await enumerateSyncFiles();
  const localChecksums: Record<string, string> = {};
  for (const file of localFiles) {
    try {
      const buf = await fs.readFile(file.absolutePath);
      localChecksums[file.relativeSyncKey] = computeChecksum(buf);
    } catch {
      continue;
    }
  }
  return localChecksums;
}

export function findConflicts(
  syncState: SyncState,
  localChecksums: Record<string, string>,
  remoteChecksums: Record<string, string>
): ConflictEntry[] {
  const allKeys = new Set([
    ...Object.keys(localChecksums),
    ...Object.keys(remoteChecksums),
    ...Object.keys(syncState.localChecksums),
    ...Object.keys(syncState.remoteChecksums),
  ]);

  const conflicts: ConflictEntry[] = [];
  for (const key of allKeys) {
    const baseLocal = syncState.localChecksums[key];
    const baseRemote = syncState.remoteChecksums[key];
    const currentLocal = localChecksums[key];
    const currentRemote = remoteChecksums[key];
    const localChanged = currentLocal !== baseLocal;
    const remoteChanged = currentRemote !== baseRemote;

    if (localChanged && remoteChanged && currentLocal !== currentRemote) {
      conflicts.push({
        relativeSyncKey: key,
        localChecksum: currentLocal ?? "",
        remoteChecksum: currentRemote ?? "",
        baseChecksum: baseLocal ?? baseRemote ?? "",
      });
    }
  }
  return conflicts;
}

export async function registerPendingConflicts(
  conflicts: ConflictEntry[]
): Promise<void> {
  if (conflicts.length === 0) {
    pendingConflicts = [];
    await vscode.commands.executeCommand(
      "setContext",
      "cursorSync.hasConflicts",
      false
    );
    return;
  }
  pendingConflicts = conflicts;
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.hasConflicts",
    true
  );
}

export async function detectConflicts(
  context: vscode.ExtensionContext,
  remoteChecksums: Record<string, string>
): Promise<ConflictEntry[]> {
  resolutionsContext = context;
  const syncState = await loadSyncState(context);
  if (!syncState) {
    return [];
  }

  const localChecksums = await computeLocalChecksums();
  const conflicts = findConflicts(syncState, localChecksums, remoteChecksums);
  await registerPendingConflicts(getUnresolvedConflicts(conflicts));
  return conflicts;
}

export async function resolveConflictsCommand(
  context: vscode.ExtensionContext
): Promise<void> {
  resolutionsContext = context;
  const logger = getLogger();

  if (pendingConflicts.length === 0) {
    vscode.window.showInformationMessage("No conflicts to resolve.");
    return;
  }

  const resolutions: ResolvedConflict[] = [];

  for (const conflict of pendingConflicts) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Keep Local", value: "keepLocal" as ConflictResolution },
        { label: "Keep Remote", value: "keepRemote" as ConflictResolution },
        { label: "Skip (decide later)", value: "skip" as ConflictResolution },
      ],
      {
        title: `Conflict: ${conflict.relativeSyncKey}`,
        placeHolder: "Choose which version to keep",
      }
    );

    if (!choice) {
      return;
    }

    resolutions.push({
      relativeSyncKey: conflict.relativeSyncKey,
      resolution: choice.value,
    });
  }

  pendingResolutions = resolutions;
  await persistPendingResolutions();

  const hasSkipped = resolutions.some((r) => r.resolution === "skip");
  if (!hasSkipped) {
    pendingConflicts = [];
    await vscode.commands.executeCommand(
      "setContext",
      "cursorSync.hasConflicts",
      false
    );
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Conflicts resolved: ${resolutions.length} decisions`
  );

  if (hasSkipped) {
    vscode.window.showInformationMessage(
      `Resolved ${resolutions.length} conflict(s). Skipped items still need a decision before sync.`
    );
    return;
  }

  vscode.window.showInformationMessage(
    `Resolved ${resolutions.length} conflict(s). Syncing now...`
  );
  // Defer so callers (push/pull) can release their sync locks first.
  setTimeout(() => {
    void vscode.commands.executeCommand("cursorSync.syncNow");
  }, 0);
}

export function getResolutionForKey(
  key: string
): ConflictResolution | undefined {
  const entry = pendingResolutions.find((r) => r.relativeSyncKey === key);
  return entry?.resolution;
}

/** Test helper: set in-memory resolutions without globalState. */
export function setPendingResolutionsForTests(
  resolutions: ResolvedConflict[]
): void {
  pendingResolutions = resolutions;
}
