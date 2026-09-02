import * as vscode from "vscode";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { detectConflicts, getResolutionForKey, gateUnresolvedConflicts } from "./conflicts.js";
import { buildSyncDebugFailure, showSyncFailureWithDebug } from "./sync-debug.js";
import { sendEvent } from "./analytics.js";
import { TRANSCRIPT_MANIFEST_FILE_NAME } from "./transcript-bundle.js";
import {
  CHAT_BUNDLES_SYNC_KEY,
  CURSOR_CHAT_GIST_FILE_NAME,
  CURSOR_CHAT_SYNC_KEY,
  isChatSyncEnabled,
} from "./chat-sync.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import {
  buildSyncStateAfterWrite,
  createRemoteBackend,
  hasRemoteDestination,
  readDestinationSettings,
  remoteSnapshotFileNames,
  type RemoteSnapshot,
  type RemoteSyncBackend,
} from "./remote/index.js";
import type { SyncProgressReport } from "./sync-progress-events.js";
import { formatElapsedPrecise } from "./elapsed.js";
import { planPullDownloadNames } from "./pull-download-plan.js";
import type { ApiResult, ConflictEntry, Manifest, SyncState } from "./types.js";
import { throwIfAborted } from "./sync-abort.js";

export type PullTrigger = "manual" | "scheduled" | "syncNow";
export type PullRemoteFetchSuccess = {
  ok: true; backend: RemoteSyncBackend; syncState: SyncState | undefined;
  snapshot: RemoteSnapshot; manifest: Manifest; remoteChecksums: Record<string, string>;
  remoteFiles: Record<string, string>; conflicts: ConflictEntry[];
};
export type PullRemoteFetchResult = PullRemoteFetchSuccess | { ok: false };

export async function fetchPullRemote(
  context: vscode.ExtensionContext,
  trigger: PullTrigger,
  progress: vscode.Progress<SyncProgressReport> & { percent?: number },
  mirror: boolean
): Promise<PullRemoteFetchResult> {
  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] Pull started (trigger=${trigger}, mirror=${mirror})`
  );

  let syncState = await loadSyncState(context);
  const destSettings = readDestinationSettings();

  progress.report({ message: "Checking GitHub token…" });
  const token = await requireToken(context);
  if (!token) {
    const authFailedMessage =
      "GitHub token not configured. Configure your token to sync.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, authFailedMessage, {
        direction: "pull",
        category: "AUTH_FAILED",
      }),
      { title: authFailedMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: AUTH_FAILED`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
    return { ok: false };
  }

  if (destSettings.type === "repo" && !destSettings.repo) {
    const message =
      "Repository destination selected but cursorSync.destination.repo is empty (owner/name).";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, message, {
        direction: "pull",
        category: "not_configured",
      }),
      { title: message }
    );
    return { ok: false };
  }

  progress.report({
    message:
      destSettings.type === "repo"
        ? "Connecting to GitHub repository…"
        : "Connecting to GitHub Gist…",
  });
  let backend = createRemoteBackend(context, token, syncState);
  if (!backend) {
    const message =
      "Could not create remote sync backend. Check destination settings.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, message, {
        direction: "pull",
        category: "not_configured",
      }),
      { title: message }
    );
    return { ok: false };
  }

  if (!hasRemoteDestination(syncState ?? undefined)) {
    progress.report({ message: "Discovering remote…" });
    const discovered = await withRetry(() => backend!.discover());
    if (!discovered.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, discovered.error.message, {
          direction: "pull",
          category: discovered.error.category,
          statusCode: discovered.error.statusCode,
        }),
        { title: `Pull failed: ${discovered.error.message}` }
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Pull failed: ${discovered.error.category} - ${discovered.error.message}`
      );
      sendEvent(context, "sync_failed", {
        direction: "pull",
        reason: discovered.error.category,
        status_code: discovered.error.statusCode,
        trigger,
      });
      return { ok: false };
    }

    if (discovered.data) {
      syncState = buildSyncStateAfterWrite(
        syncState,
        backend,
        discovered.data.id,
        syncState?.localChecksums || {},
        "pull"
      );
      syncState.remoteChecksums = syncState.remoteChecksums || {};
      await saveSyncState(context, syncState);
      backend = createRemoteBackend(context, token, syncState) ?? backend;
      logger.appendLine(
        `[${new Date().toISOString()}] Found existing remote: ${discovered.data.id}`
      );
    } else {
      const notConfiguredMessage =
        destSettings.type === "repo"
          ? "Not configured. Push first to create the sync folder in the repository."
          : "Not configured. Push first or configure a Gist ID.";
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, notConfiguredMessage, {
          direction: "pull",
          category: "not_configured",
        }),
        { title: notConfiguredMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull failed: not configured`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
      return { ok: false };
    }
  }

  const remoteStarted = Date.now();
  progress.report({ message: "Fetching remote manifest…" });
  let snapshotResult = await withRetry(() =>
    backend!.getSnapshot({ onlyFiles: ["manifest.json"] })
  );
  if (!snapshotResult.ok) {
    await reportPullRemoteFailure(context, trigger, snapshotResult, logger);
    return { ok: false };
  }

  let snapshot = snapshotResult.data;
  const firstManifest = snapshot.files["manifest.json"];
  if (!firstManifest || !isReadableManifestJson(firstManifest)) {
    logger.appendLine(
      "[Cursor Sync] Remote manifest.json missing or unreadable; fetching full snapshot."
    );
    progress.report({ message: "Fetching remote snapshot…" });
    const snapshotFloor =
      typeof progress.percent === "number" ? progress.percent : 0;
    snapshotResult = await withRetry(() =>
      backend!.getSnapshot({
        onFileProgress: (completed, total) => {
          const ratio = total > 0 ? completed / total : 1;
          progress.report({
            message: `Fetching ${completed}/${total} changed file(s)…`,
            percent: snapshotFloor + ratio * (95 - snapshotFloor),
          });
        },
      })
    );
    if (!snapshotResult.ok) {
      await reportPullRemoteFailure(context, trigger, snapshotResult, logger);
      return { ok: false };
    }
    snapshot = snapshotResult.data;
  } else {
    const previewChecksums = checksumsFromManifestJson(firstManifest) ?? {};
    const downloadKeepLocal = new Set<string>();
    for (const key of Object.keys(previewChecksums)) {
      if (getResolutionForKey(key) === "keepLocal") {
        downloadKeepLocal.add(key);
      }
    }
    const downloadNames = planPullDownloadNames({
      manifestChecksums: previewChecksums,
      localChecksums: syncState?.localChecksums ?? {},
      allFileNames: remoteSnapshotFileNames(snapshot),
      keepLocalKeys: downloadKeepLocal,
      chatEnabled: isChatSyncEnabled(),
      chatFiles: [
        { syncKey: CURSOR_CHAT_SYNC_KEY, gistName: CURSOR_CHAT_GIST_FILE_NAME },
        { syncKey: CHAT_BUNDLES_SYNC_KEY, gistName: CHAT_BUNDLES_GIST_FILE_NAME },
      ],
    });
    if (downloadNames.length === 0) {
      logger.appendLine(
        "[Cursor Sync] Remote files already in sync; skipping content download."
      );
    } else {
      progress.report({
        message: `Fetching ${downloadNames.length} changed file(s)…`,
      });
      const downloadFloor =
        typeof progress.percent === "number" ? progress.percent : 0;
      const second = await withRetry(() =>
        backend!.getSnapshot({
          onlyFiles: downloadNames,
          onFileProgress: (completed, total) => {
            const ratio = total > 0 ? completed / total : 1;
            progress.report({
              message: `Fetching ${completed}/${total} changed file(s)…`,
              percent: downloadFloor + ratio * (95 - downloadFloor),
            });
          },
        })
      );
      if (!second.ok) {
        await reportPullRemoteFailure(context, trigger, second, logger);
        return { ok: false };
      }
      snapshot = {
        ...snapshot,
        files: { ...snapshot.files, ...second.data.files },
      };
    }
  }

  logger.appendLine(
    `[Cursor Sync] Remote snapshot ready in ${formatElapsedPrecise(Date.now() - remoteStarted)} (${Object.keys(snapshot.files).length} file(s) downloaded).`
  );

  const remoteFiles = snapshot.files;
  const manifestContent = remoteFiles["manifest.json"];
  if (!manifestContent) {
    const message =
      remoteFiles[TRANSCRIPT_MANIFEST_FILE_NAME] !== undefined
        ? "Pull failed: This remote contains agent transcripts, not settings. Use a Cursor Sync settings backup, or Import Agent Transcripts from Private Gist."
        : "Pull failed: manifest.json not found on remote.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, message, {
        direction: "pull",
        category: "missing_manifest",
      }),
      { title: message }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: missing manifest`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "missing_manifest", trigger });
    return { ok: false };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestContent) as Manifest;
  } catch {
    const invalidManifestMessage = "Pull failed: invalid manifest.json.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, invalidManifestMessage, {
        direction: "pull",
        category: "invalid_manifest",
      }),
      { title: invalidManifestMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: invalid manifest`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "invalid_manifest", trigger });
    return { ok: false };
  }

  const remoteChecksums: Record<string, string> = {};
  for (const [key, entry] of Object.entries(manifest.files)) {
    remoteChecksums[key] = entry.checksum;
  }

  progress.report({ message: "Checking for conflicts…" });
  const conflicts = await detectConflicts(context, remoteChecksums);
  if (conflicts.length > 0) {
    const { unresolved, prompted } = await gateUnresolvedConflicts(trigger, conflicts);
    throwIfAborted();
    if (unresolved.length > 0) {
      const conflictMessage = `${unresolved.length} conflict(s) detected. Resolve them before pulling.`;
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, conflictMessage, {
          direction: "pull",
          category: "CONFLICT",
          conflictCount: unresolved.length,
        }),
        { level: "warning", title: conflictMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull blocked: CONFLICT`);
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "pull",
        trigger,
        fileCount: 0,
        success: false,
        error: "Unresolved conflicts",
        files: unresolved.map((c) => c.relativeSyncKey).sort(),
      });
      sendEvent(context, "sync_failed", { direction: "pull", reason: "CONFLICT", trigger });
      return { ok: false };
    }
    if (prompted) {
      return { ok: false };
    }
  }

  return {
    ok: true,
    backend: backend!,
    syncState,
    snapshot,
    manifest,
    remoteChecksums,
    remoteFiles,
    conflicts,
  };
}

function isReadableManifestJson(raw: string): boolean {
  return checksumsFromManifestJson(raw) !== undefined;
}

function checksumsFromManifestJson(raw: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(raw) as { files?: Record<string, { checksum?: string }> };
    if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
      return undefined;
    }
    const checksums: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed.files)) {
      if (entry?.checksum) checksums[key] = entry.checksum;
    }
    return checksums;
  } catch {
    return undefined;
  }
}

async function reportPullRemoteFailure(
  context: vscode.ExtensionContext,
  trigger: PullTrigger,
  snapshotResult: Extract<ApiResult<RemoteSnapshot>, { ok: false }>,
  logger: vscode.OutputChannel
): Promise<void> {
  if (snapshotResult.error.category === "CANCELLED") {
    logger.appendLine(`[${new Date().toISOString()}] Pull cancelled`);
    return;
  }
  void showSyncFailureWithDebug(
    context,
    buildSyncDebugFailure("pull", trigger, snapshotResult.error.message, {
      direction: "pull",
      category: snapshotResult.error.category,
      statusCode: snapshotResult.error.statusCode,
    }),
    { title: `Pull failed: ${snapshotResult.error.message}` }
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Pull failed: ${snapshotResult.error.category} - ${snapshotResult.error.message}`
  );
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "pull",
    trigger,
    fileCount: 0,
    success: false,
    error: snapshotResult.error.message,
  });
  sendEvent(context, "sync_failed", {
    direction: "pull",
    reason: snapshotResult.error.category,
    status_code: snapshotResult.error.statusCode,
    trigger,
  });
}
