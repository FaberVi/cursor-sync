import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import type {
  SyncState,
  ConflictEntry,
  ResolvedConflict,
  ConflictResolution,
} from "./types.js";
import { computeChecksum } from "./packaging.js";
import { enumerateSyncFiles, isMcpSyncEnabled, isMcpSyncKey } from "./paths.js";
import { ensureExtensionsJsonOnDisk } from "./extensions.js";
import { loadSyncState } from "./diagnostics.js";
import { getLogger } from "./diagnostics.js";
import { notifySyncQuiet, notifySyncActionRequired } from "./sync-notify.js";
import { getSyncAbortSignal } from "./sync-abort.js";

const PENDING_RESOLUTIONS_KEY = "cursorSync.pendingConflictResolutions";

let pendingResolutions: ResolvedConflict[] = [];
let pendingConflicts: ConflictEntry[] = [];
let resolutionsContext: vscode.ExtensionContext | undefined;

type SidebarConflictWaiter = {
  promise: Promise<void>;
  resolve: () => void;
};

let sidebarConflictWaiter: SidebarConflictWaiter | undefined;

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

export type ConflictGateResult = {
  unresolved: ConflictEntry[];
  /** true only if this pass awaited cursorSync.resolveConflicts */
  prompted: boolean;
};

export async function gateUnresolvedConflicts(
  trigger: "manual" | "scheduled" | "syncNow",
  conflicts: ConflictEntry[]
): Promise<ConflictGateResult> {
  if (getUnresolvedConflicts(conflicts).length === 0) {
    return { unresolved: [], prompted: false };
  }
  if (trigger === "scheduled") {
    return { unresolved: getUnresolvedConflicts(conflicts), prompted: false };
  }
  await vscode.commands.executeCommand("cursorSync.resolveConflicts");
  return {
    unresolved: getUnresolvedConflicts(conflicts),
    prompted: true,
  };
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
  completeSidebarConflictWaiter();
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
      if (isMcpSyncKey(key) && !isMcpSyncEnabled()) {
        continue;
      }
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

export async function applyConflictResolution(
  relativeSyncKey: string,
  resolution: ConflictResolution
): Promise<void> {
  const rest = pendingResolutions.filter((r) => r.relativeSyncKey !== relativeSyncKey);
  pendingResolutions = [...rest, { relativeSyncKey, resolution }];
  await persistPendingResolutions();
  await syncConflictContext();
  const { refreshSidebar } = await import("./sidebar/index.js");
  refreshSidebar();
  await maybeFinishResolvedConflicts();
}

export async function applyConflictResolutionToAll(
  resolution: ConflictResolution
): Promise<void> {
  pendingResolutions = pendingConflicts.map((c) => ({
    relativeSyncKey: c.relativeSyncKey,
    resolution,
  }));
  await persistPendingResolutions();
  await syncConflictContext();
  const { refreshSidebar } = await import("./sidebar/index.js");
  refreshSidebar();
  await maybeFinishResolvedConflicts();
}

function allPendingHaveExplicitResolution(): boolean {
  if (pendingConflicts.length === 0) {
    return true;
  }
  return pendingConflicts.every((c) => {
    const resolution = getResolutionForKey(c.relativeSyncKey);
    return (
      resolution === "keepLocal" ||
      resolution === "keepRemote" ||
      resolution === "skip"
    );
  });
}

function completeSidebarConflictWaiter(): void {
  const waiter = sidebarConflictWaiter;
  sidebarConflictWaiter = undefined;
  waiter?.resolve();
}

function maybeCompleteSidebarConflictWaiter(): void {
  if (getSyncAbortSignal()?.aborted || allPendingHaveExplicitResolution()) {
    completeSidebarConflictWaiter();
  }
}

function waitForSidebarConflictDecisions(): Promise<void> {
  if (getSyncAbortSignal()?.aborted || allPendingHaveExplicitResolution()) {
    return Promise.resolve();
  }
  if (sidebarConflictWaiter) {
    return sidebarConflictWaiter.promise;
  }
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  sidebarConflictWaiter = { promise, resolve: resolveFn };
  const signal = getSyncAbortSignal();
  signal?.addEventListener("abort", completeSidebarConflictWaiter, {
    once: true,
  });
  if (signal?.aborted || allPendingHaveExplicitResolution()) {
    completeSidebarConflictWaiter();
  }
  return promise;
}

async function syncConflictContext(): Promise<void> {
  const unresolved = getUnresolvedConflicts(pendingConflicts);
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.hasConflicts",
    unresolved.length > 0
  );
}

async function maybeFinishResolvedConflicts(): Promise<void> {
  maybeCompleteSidebarConflictWaiter();
  if (pendingConflicts.length === 0) {
    return;
  }
  if (getUnresolvedConflicts(pendingConflicts).length > 0) {
    return;
  }
  void notifySyncActionRequired(
    "Conflicts resolved. Press Sync Now to apply."
  );
}

export async function resolveConflictsCommand(
  context: vscode.ExtensionContext
): Promise<void> {
  resolutionsContext = context;
  const logger = getLogger();

  if (pendingConflicts.length === 0) {
    notifySyncQuiet("No conflicts to resolve.");
    return;
  }

  const { isSidebarVisible, revealSidebar, refreshSidebar } = await import(
    "./sidebar/index.js"
  );
  revealSidebar();
  if (isSidebarVisible()) {
    refreshSidebar();
    await waitForSidebarConflictDecisions();
    return;
  }

  const cts = new vscode.CancellationTokenSource();
  const signal = getSyncAbortSignal();
  const onAbort = (): void => cts.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  let allChoice:
    | { label: string; value: ConflictResolution }
    | undefined;
  try {
    allChoice = await vscode.window.showQuickPick(
      [
        { label: "Keep Local (all files)", value: "keepLocal" as ConflictResolution },
        { label: "Keep Remote (all files)", value: "keepRemote" as ConflictResolution },
        { label: "Skip all (decide later)", value: "skip" as ConflictResolution },
      ],
      {
        title: `Resolve ${pendingConflicts.length} conflict(s)`,
        placeHolder: "Apply one decision to every conflicted file",
      },
      cts.token
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cts.dispose();
  }
  if (!allChoice) {
    return;
  }

  await applyConflictResolutionToAll(allChoice.value);
  logger.appendLine(
    `[${new Date().toISOString()}] Conflicts resolved: ${pendingResolutions.length} decisions (${allChoice.value})`
  );
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
