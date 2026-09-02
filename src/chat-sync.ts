import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import { fetchGistFileContent } from "./gist.js";
import type { GistFile } from "./types.js";
import { getLogger } from "./diagnostics.js";
import { computeChecksum } from "./packaging.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import {
  collectLocalChatIdentities,
  discoverBackupEligibleConversations,
} from "./chat-discovery.js";
import { restoreOptionsFromConfiguration } from "./chat-persistence.js";
import { restoreChatBundlesBatch } from "./chat-import-ux.js";
import { maybeActivateChatsAfterPull } from "./chat-pull-activation.js";
import { shouldSkipChatPackaging } from "./chat-sync-skip.js";
import { isRemoteChatPresentLocally } from "./chat-identity.js";
import {
  CURSOR_CHAT_GIST_FILE_NAME,
  CURSOR_CHAT_SYNC_KEY,
  decryptGistChatContent,
  getChatPullUpdatePolicy,
  isChatPullUpdatesEnabled,
  noopChatSyncProgress,
  parseSyncChatCollection,
  readImportedChatTimestamps,
  selectChatsForPull,
  storeImportedChatTimestamps,
} from "./chat-sync-collection.js";

export {
  aggregateChatSyncFidelity,
  formatChatSyncFidelityToast,
} from "./chat-backup-eligibility.js";
export { shouldSkipChatPackaging } from "./chat-sync-skip.js";
export {
  CHAT_BUNDLES_SYNC_KEY,
  CURSOR_CHAT_SYNC_KEY,
  CURSOR_CHAT_GIST_FILE_NAME,
  LEGACY_CHAT_BUNDLES_GIST_FILE,
  mergeChatCollections,
  isChatSyncOnlyFullBackups,
  isChatPullUpdatesEnabled,
  getChatPullUpdatePolicy,
  readImportedChatTimestamps,
  storeImportedChatTimestamps,
  selectChatsForPull,
  selectChatsToPull,
  collectionJsonFromBundles,
  legacyCollectionJsonFromBundles,
  parseSyncChatCollection,
  parseChatCollectionFromPlaintext,
  computeChatCollectionChecksum,
  fetchRemoteChatCollectionFromFiles,
  fetchRemoteChatCollection,
  buildChatCollectionForSync,
} from "./chat-sync-collection.js";
export type {
  ChatPullUpdatePolicy,
  ChatPullSelection,
  ParsedSyncChatCollection,
} from "./chat-sync-collection.js";
export { prepareChatSyncPushPayload } from "./chat-sync-push.js";
export type { ChatSyncPushPayload } from "./chat-sync-push.js";

export function isChatSyncEnabled(): boolean {
  return (
    vscode.workspace.getConfiguration("cursorSync").get<boolean>("chats.syncEnabled") ??
    false
  );
}

export function getChatCollectionMaxBytes(): number {
  const kb =
    vscode.workspace.getConfiguration("cursorSync").get<number>("chats.maxCollectionSizeKB") ??
    8192;
  return Math.max(0, kb) * 1024;
}

export interface ChatSyncPullResult {
  imported: number;
  skipped: number;
  updated: number;
  warnings: string[];
}

export async function pullChatCollectionFromRemoteFiles(
  context: vscode.ExtensionContext,
  files: Record<string, string>,
  progress: vscode.Progress<{ message?: string; increment?: number }> = noopChatSyncProgress
): Promise<ChatSyncPullResult> {
  const logger = getLogger();
  const raw =
    files[CURSOR_CHAT_GIST_FILE_NAME] ?? files[CHAT_BUNDLES_GIST_FILE_NAME];
  if (raw === undefined) {
    return { imported: 0, skipped: 0, updated: 0, warnings: [] };
  }

  const plaintext = await decryptGistChatContent(context, raw);
  const collection = parseSyncChatCollection(plaintext);
  const localIdentities = await collectLocalChatIdentities();
  const pullUpdates = isChatPullUpdatesEnabled();
  const policy = getChatPullUpdatePolicy();
  const localImportTimestamps = await readImportedChatTimestamps(context);

  let selection = selectChatsForPull(collection.bundles, localIdentities, {
    pullUpdates,
    policy,
    localImportTimestamps,
  });

  if (pullUpdates && policy === "ask" && selection.skipped > 0) {
    const updatable = collection.bundles.filter((b) =>
      isRemoteChatPresentLocally(b, localIdentities)
    );
    if (updatable.length > 0) {
      const choice = await vscode.window.showInformationMessage(
        `${updatable.length} chat(s) already exist locally. Update from remote?`,
        "Update all",
        "New only"
      );
      if (choice === "Update all") {
        selection = selectChatsForPull(collection.bundles, localIdentities, {
          pullUpdates: true,
          policy: "remoteWins",
          localImportTimestamps,
        });
      }
    }
  }

  const toImport = selection.toImport;
  const skipped = selection.skipped;
  const updated = selection.updated;

  if (toImport.length === 0) {
    logger.appendLine(
      `[${new Date().toISOString()}] [chat-sync] pull: 0 imported, ${skipped} skipped (already local)`
    );
    return { imported: 0, skipped, updated, warnings: [] };
  }

  const restoreOptions = restoreOptionsFromConfiguration();
  const batch = await restoreChatBundlesBatch(
    context,
    toImport,
    restoreOptions,
    progress,
    "gist-chat-import"
  );

  if (batch.successes.length > 0) {
    await storeImportedChatTimestamps(
      context,
      toImport.filter((b) =>
        batch.successes.some(
          (s) =>
            s.conversationId === b.conversationId &&
            (s.sourceFolderTilde ?? "").trim() === (b.sourceFolderTilde ?? "").trim()
        )
      )
    );
    await maybeActivateChatsAfterPull(context, toImport, batch.successes, restoreOptions);
  }

  const warnings = batch.failures.map((f) => `${f.bundle.conversationId}: ${f.error}`);
  for (const failure of batch.failures) {
    logger.appendLine(
      `[${new Date().toISOString()}] [chat-sync] pull fail conversationId=${failure.bundle.conversationId}: ${failure.error}`
    );
  }
  logger.appendLine(
    `[${new Date().toISOString()}] [chat-sync] pull: ${batch.successes.length} imported, ${skipped} skipped, ${updated} updated`
  );
  return {
    imported: batch.successes.length,
    skipped,
    updated,
    warnings,
  };
}

export async function pullChatCollectionFromGist(
  context: vscode.ExtensionContext,
  gistFiles: Record<string, GistFile | undefined>,
  token: string,
  progress: vscode.Progress<{ message?: string; increment?: number }> = noopChatSyncProgress
): Promise<ChatSyncPullResult> {
  const files: Record<string, string> = {};
  for (const [name, file] of Object.entries(gistFiles)) {
    if (!file) {
      continue;
    }
    files[name] = await fetchGistFileContent(file, token);
  }
  return pullChatCollectionFromRemoteFiles(context, files, progress);
}

export async function computeLocalChatCollectionChecksum(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  if (!isChatSyncEnabled()) {
    return undefined;
  }
  return computeChatSyncLocalFingerprint();
}

export async function countLocalDiscoveredChats(): Promise<number> {
  const discovered = await discoverBackupEligibleConversations();
  return discovered.length;
}

const CHAT_SYNC_FINGERPRINT_KEY = "cursorSync.chatSyncLocalFingerprint";

export function chatSyncFingerprintLine(d: {
  conversationId: string;
  workspaceKey: string;
  hasStore: boolean;
  jsonlCount: number;
  storeSizeBytes?: number;
  storeMtimeMs?: number;
  transcriptMtimeMs?: number;
}): string {
  return `${d.conversationId}:${d.workspaceKey}:${d.hasStore ? 1 : 0}:${d.jsonlCount}:${d.storeSizeBytes ?? 0}:${d.storeMtimeMs ?? 0}:${d.transcriptMtimeMs ?? 0}`;
}

export function computeChatSyncFingerprintFromDiscovery(
  discovered: Array<{
    conversationId: string;
    workspaceKey: string;
    hasStore: boolean;
    jsonlCount: number;
    storeSizeBytes?: number;
    storeMtimeMs?: number;
    transcriptMtimeMs?: number;
  }>
): string {
  const payload = discovered.map(chatSyncFingerprintLine).sort().join("|");
  return computeChecksum(Buffer.from(payload, "utf-8"));
}

export async function computeChatSyncLocalFingerprint(): Promise<string> {
  const discovered = await discoverBackupEligibleConversations();
  return computeChatSyncFingerprintFromDiscovery(discovered);
}

export async function readStoredChatSyncFingerprint(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.globalState.get<string>(CHAT_SYNC_FINGERPRINT_KEY);
}

export async function storeChatSyncFingerprint(
  context: vscode.ExtensionContext,
  fingerprint: string
): Promise<void> {
  await context.globalState.update(CHAT_SYNC_FINGERPRINT_KEY, fingerprint);
}

/**
 * True when local chat discovery metadata matches the last successful sync
 * fingerprint and the remote still has the chat collection checksum we last
 * pushed/pulled — so full chat packaging can be skipped.
 */
export async function canSkipChatPackaging(
  context: vscode.ExtensionContext,
  remoteChecksums: Record<string, string>,
  syncState: { localChecksums: Record<string, string> } | undefined
): Promise<boolean> {
  if (!syncState) {
    return false;
  }
  const current = await computeChatSyncLocalFingerprint();
  return shouldSkipChatPackaging({
    remoteChecksum: remoteChecksums[CURSOR_CHAT_SYNC_KEY],
    lastLocalChecksum: syncState.localChecksums[CURSOR_CHAT_SYNC_KEY],
    storedFingerprint: await readStoredChatSyncFingerprint(context),
    currentFingerprint: current,
  });
}
