import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import type { ChatBundle } from "./chat-persistence.js";
import { aggregateChatSyncFidelity, type ChatSyncFidelityReport } from "./chat-backup-eligibility.js";
import {
  buildChatCollectionForSync,
  collectionJsonFromBundles,
  computeChatCollectionChecksum,
  encryptCollectionForGist,
  fetchRemoteChatCollection,
  mergeChatCollections,
  noopChatSyncProgress,
} from "./chat-sync-collection.js";
import { CURSOR_CHAT_GIST_FILE_NAME, CURSOR_CHAT_SYNC_KEY } from "./chat-sync-collection.js";

export interface ChatSyncPushPayload {
  gistFileName: string;
  content: string;
  syncKey: string;
  checksum: string;
  sizeBytes: number;
  bundleCount: number;
  fidelityReport: ChatSyncFidelityReport;
}

export async function prepareChatSyncPushPayload(
  context: vscode.ExtensionContext,
  fetchRemote:
    | (() => Promise<ChatBundle[] | null>)
    | string
    | undefined,
  tokenOrProgress?:
    | string
    | vscode.Progress<{ message?: string; increment?: number }>,
  progress: vscode.Progress<{ message?: string; increment?: number }> = noopChatSyncProgress
): Promise<ChatSyncPushPayload | null> {
  // Backward-compatible overload: (context, gistId, token, progress)
  let remoteFetcher: (() => Promise<ChatBundle[] | null>) | undefined;
  let resolvedProgress = progress;
  if (typeof fetchRemote === "string" || fetchRemote === undefined) {
    const gistId = fetchRemote;
    const token = typeof tokenOrProgress === "string" ? tokenOrProgress : "";
    if (typeof tokenOrProgress !== "string" && tokenOrProgress) {
      resolvedProgress = tokenOrProgress;
    }
    if (gistId && token) {
      remoteFetcher = () => fetchRemoteChatCollection(context, gistId, token);
    }
  } else {
    remoteFetcher = fetchRemote;
    if (tokenOrProgress && typeof tokenOrProgress !== "string") {
      resolvedProgress = tokenOrProgress;
    }
  }

  const { bundles: localBundles, warnings } = await buildChatCollectionForSync(
    context,
    resolvedProgress
  );
  for (const w of warnings) {
    getLogger().appendLine(`[${new Date().toISOString()}] [chat-sync] ${w}`);
  }

  let remoteBundles: ChatBundle[] = [];
  if (remoteFetcher) {
    try {
      remoteBundles = (await remoteFetcher()) ?? [];
    } catch (err) {
      getLogger().appendLine(
        `[${new Date().toISOString()}] [chat-sync] remote fetch warn: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const merged = mergeChatCollections(remoteBundles, localBundles);
  if (merged.length === 0) {
    return null;
  }

  const fidelityReport = aggregateChatSyncFidelity(merged);
  const plaintext = collectionJsonFromBundles(merged);
  const content = await encryptCollectionForGist(context, plaintext);
  const checksum = computeChatCollectionChecksum(content);
  return {
    gistFileName: CURSOR_CHAT_GIST_FILE_NAME,
    content,
    syncKey: CURSOR_CHAT_SYNC_KEY,
    checksum,
    sizeBytes: Buffer.byteLength(content, "utf-8"),
    bundleCount: merged.length,
    fidelityReport,
  };
}
