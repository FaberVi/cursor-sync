import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { getToken } from "./auth.js";
import { getLogger, loadSyncState } from "./diagnostics.js";
import { runGit } from "./git-cli.js";
import { isRepoDestinationConfigured } from "./remote/destination.js";
import {
  ensureSyncClone,
  fetchOrigin,
  getSyncClonePath,
  readRepoIdentity,
  relationToOrigin,
  type GitRelation,
} from "./sync-clone.js";
import { isSyncLocked } from "./sync-lock.js";
import { notifySyncActionRequired } from "./sync-notify.js";
import { getStatusBarState, updateStatusBar } from "./statusbar.js";
import { statusWarningPlain, t } from "./sidebar/i18n.js";
import { getPendingConflictCount } from "./conflict-panel.js";
import { getLocalDiffersCache } from "./cursor-differs.js";

export const REMOTE_AHEAD_INTERVAL_MS = 300_000;

export type RemoteAheadCache = {
  relation: GitRelation;
  originSha?: string;
  behindCount?: number;
  checkedAt: number;
};

let cache: RemoteAheadCache | undefined;
let toastedEpisode: "behind" | "diverged" | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let probing = false;

export function getRemoteAheadCache(): RemoteAheadCache | undefined {
  return cache;
}

export function __resetRemoteAheadForTests(): void {
  cache = undefined;
  toastedEpisode = undefined;
  probing = false;
  stopRemoteAheadWatch();
}

export function recordRemoteRelation(
  partial: Partial<RemoteAheadCache> & { relation: GitRelation }
): void {
  cache = {
    relation: partial.relation,
    originSha: partial.originSha ?? cache?.originSha,
    behindCount: partial.behindCount ?? cache?.behindCount,
    checkedAt: Date.now(),
  };
  if (partial.relation !== "behind" && partial.relation !== "diverged") {
    toastedEpisode = undefined;
    cache.behindCount = undefined;
  }
  void refreshSidebarSafe();
  syncStatusBarWithRemoteAheadCache();
}

export async function probeRemoteAhead(
  context: vscode.ExtensionContext
): Promise<void> {
  if (probing) {
    return;
  }
  if (!isRepoDestinationConfigured()) {
    return;
  }
  if (isSyncLocked()) {
    return;
  }
  const token = await getToken(context);
  if (!token) {
    return;
  }
  if (getPendingConflictCount() > 0) {
    return;
  }

  probing = true;
  try {
    const identity = readRepoIdentity();
    if (!identity) {
      return;
    }
    const clonePath = getSyncClonePath(context);
    const hasGit = await cloneGitExists(clonePath);
    if (hasGit) {
      await fetchOrigin(clonePath, token);
    } else {
      await ensureSyncClone(context, token);
    }
    const relation = await relationToOrigin(clonePath, identity.branch);
    let originSha: string | undefined;
    try {
      const parsed = await runGit({
        args: ["rev-parse", `origin/${identity.branch}`],
        cwd: clonePath,
      });
      originSha = parsed.stdout.trim() || undefined;
    } catch {
      originSha = undefined;
    }
    let behindCount: number | undefined;
    try {
      const counted = await runGit({
        args: ["rev-list", "--count", `HEAD..origin/${identity.branch}`],
        cwd: clonePath,
      });
      const n = Number.parseInt(counted.stdout.trim(), 10);
      if (Number.isFinite(n)) {
        behindCount = n;
      }
    } catch {
      behindCount = undefined;
    }
    recordRemoteRelation({ relation, originSha, behindCount });
    await maybeToastRemoteAhead();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().appendLine(
      `[${new Date().toISOString()}] remote-ahead probe failed: ${msg}`
    );
  } finally {
    probing = false;
  }
}

export async function maybeToastRemoteAhead(): Promise<void> {
  const rel = cache?.relation;
  if (rel !== "behind" && rel !== "diverged") {
    toastedEpisode = undefined;
    return;
  }
  if (toastedEpisode === rel) {
    return;
  }
  if (isSyncLocked()) {
    return;
  }
  toastedEpisode = rel;
  const later = t("later");
  if (rel === "diverged") {
    const message = statusWarningPlain("diverged");
    const reset = t("resetToRemote");
    const choice = await notifySyncActionRequired(message, reset, later);
    if (choice === reset) {
      await import("vscode").then((vscode) =>
        vscode.commands.executeCommand("cursorSync.resetToRemote")
      );
    }
    return;
  }
  const message = statusWarningPlain("behind");
  const syncNow = t("syncNow");
  const choice = await notifySyncActionRequired(message, syncNow, later);
  if (choice === syncNow) {
    await import("vscode").then((vscode) =>
      vscode.commands.executeCommand("cursorSync.syncNow")
    );
  }
}

export function syncStatusBarWithRemoteAheadCache(
  lastSync?: Date,
  options?: { includeUnconfigured?: boolean; includeSyncing?: boolean }
): void {
  const bar = getStatusBarState();
  if (bar === "error") {
    return;
  }
  if (bar === "syncing" && !options?.includeSyncing) {
    return;
  }
  if (bar === "unconfigured" && !options?.includeUnconfigured) {
    return;
  }
  const rel = cache?.relation;
  if (rel === "behind" || rel === "diverged") {
    updateStatusBar(
      "behind",
      lastSync,
      rel === "diverged" ? statusWarningPlain("diverged") : statusWarningPlain("behind")
    );
    return;
  }
  if (rel === "ahead" || rel === "empty" || getLocalDiffersCache() !== false) {
    updateStatusBar("not-synced", lastSync);
    return;
  }
  if (rel === "equal") {
    updateStatusBar("ok", lastSync);
  }
}

export async function onSyncLockReleased(
  context: vscode.ExtensionContext
): Promise<void> {
  const bar = getStatusBarState();
  if (bar !== "syncing" && bar !== "error" && bar !== "unconfigured") {
    const syncState = await loadSyncState(context);
    const lastSync = syncState
      ? new Date(syncState.lastSyncTimestamp)
      : undefined;
    syncStatusBarWithRemoteAheadCache(lastSync);
  }
  await maybeToastRemoteAhead();
}

export function startRemoteAheadWatch(context: vscode.ExtensionContext): void {
  stopRemoteAheadWatch();
  void probeRemoteAhead(context);
  timer = setInterval(() => {
    void probeRemoteAhead(context);
  }, REMOTE_AHEAD_INTERVAL_MS);
}

export function stopRemoteAheadWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function cloneGitExists(clonePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(clonePath, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

async function refreshSidebarSafe(): Promise<void> {
  const { refreshSidebar } = await import("./sidebar/index.js");
  refreshSidebar();
}
