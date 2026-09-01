import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import { getLogger, loadSyncState } from "./diagnostics.js";
import { computeChecksum } from "./packaging.js";
import {
  CHAT_BUNDLES_GIST_FILE_NAME,
  buildChatBundlesCollection,
  parseChatBundleOrCollection,
  type ChatBundlesCollection,
} from "./chat-bundle-format.js";
import { discoverBackupEligibleConversations } from "./chat-discovery.js";
import { buildChatBundle, type ChatBundle } from "./chat-persistence.js";
import { enrichBundleWithLiveDiskKv } from "./chat-disk-kv-export.js";
import {
  bundlesFromNativeCollection,
  chatBundleFromNativeChatJson,
  isNativeChatCollection,
  isNativeChatJsonDocument,
  nativeCollectionFromBundles,
} from "./native-chat-json/index.js";
import { GistBackend } from "./remote/gist-backend.js";
import { createRemoteBackend } from "./remote/factory.js";
import {
  decryptChatGistPayload,
  encryptChatGistPayload,
  isEncryptedChatGistPayload,
  ChatGistCryptoError,
} from "./chat-gist-crypto.js";
import {
  isChatGistEncryptionEnabled,
  requireChatEncryptionPassword,
  setChatEncryptionPassword,
  clearChatEncryptionPassword,
} from "./chat-encryption-auth.js";
import { isBundleSyncEligible } from "./chat-backup-eligibility.js";
import { getChatCollectionMaxBytes } from "./chat-sync.js";

export const CHAT_BUNDLES_SYNC_KEY = "dot-cursor/chat-bundles.json";
export const CURSOR_CHAT_SYNC_KEY = "dot-cursor/cursor-chat.json";
export const CURSOR_CHAT_GIST_FILE_NAME = "cursor-chat.json";

/** @deprecated Legacy sync file; new pushes use {@link CURSOR_CHAT_GIST_FILE_NAME}. */
export const LEGACY_CHAT_BUNDLES_GIST_FILE = CHAT_BUNDLES_GIST_FILE_NAME;

const SQLITE_READ_RETRIES = 5;

export const noopChatSyncProgress: vscode.Progress<{ message?: string; increment?: number }> = {
  report: () => {},
};

function bundleTimestamp(bundle: ChatBundle): number {
  const parsed = Date.parse(bundle.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeChatCollections(
  remote: ChatBundle[],
  local: ChatBundle[]
): ChatBundle[] {
  const byId = new Map<string, ChatBundle>();
  for (const bundle of remote) {
    byId.set(bundle.conversationId, bundle);
  }
  for (const bundle of local) {
    const existing = byId.get(bundle.conversationId);
    if (!existing || bundleTimestamp(bundle) >= bundleTimestamp(existing)) {
      byId.set(bundle.conversationId, bundle);
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.conversationId.localeCompare(b.conversationId)
  );
}

export function isChatSyncOnlyFullBackups(): boolean {
  return (
    vscode.workspace
      .getConfiguration("cursorSync")
      .get<boolean>("chats.syncOnlyFullBackups") ?? false
  );
}

export type ChatPullUpdatePolicy = "skip" | "remoteWins" | "newerWins" | "ask";

export function isChatPullUpdatesEnabled(): boolean {
  return (
    vscode.workspace.getConfiguration("cursorSync").get<boolean>("chats.pullUpdates") ??
    false
  );
}

export function getChatPullUpdatePolicy(): ChatPullUpdatePolicy {
  const raw = vscode.workspace
    .getConfiguration("cursorSync")
    .get<string>("chats.pullUpdatePolicy");
  if (raw === "remoteWins" || raw === "newerWins" || raw === "ask") {
    return raw;
  }
  return "skip";
}

const CHAT_IMPORT_TIMESTAMPS_KEY = "cursorSync.chatImportTimestamps";

export async function readImportedChatTimestamps(
  context: vscode.ExtensionContext
): Promise<Map<string, number>> {
  const raw = context.globalState.get<Record<string, string>>(CHAT_IMPORT_TIMESTAMPS_KEY);
  const map = new Map<string, number>();
  if (!raw) {
    return map;
  }
  for (const [id, iso] of Object.entries(raw)) {
    const ts = Date.parse(iso);
    if (Number.isFinite(ts)) {
      map.set(id, ts);
    }
  }
  return map;
}

export async function storeImportedChatTimestamps(
  context: vscode.ExtensionContext,
  bundles: ChatBundle[]
): Promise<void> {
  const existing =
    context.globalState.get<Record<string, string>>(CHAT_IMPORT_TIMESTAMPS_KEY) ?? {};
  const next = { ...existing };
  for (const bundle of bundles) {
    next[bundle.conversationId] = bundle.createdAt;
  }
  await context.globalState.update(CHAT_IMPORT_TIMESTAMPS_KEY, next);
}

export interface ChatPullSelection {
  toImport: ChatBundle[];
  updated: number;
  skipped: number;
}

export function selectChatsForPull(
  remoteBundles: ChatBundle[],
  localConversationIds: Set<string>,
  options: {
    pullUpdates: boolean;
    policy: ChatPullUpdatePolicy;
    localImportTimestamps?: Map<string, number>;
  }
): ChatPullSelection {
  if (!options.pullUpdates || options.policy === "skip") {
    const toImport = remoteBundles.filter((b) => !localConversationIds.has(b.conversationId));
    return {
      toImport,
      updated: 0,
      skipped: remoteBundles.length - toImport.length,
    };
  }

  const toImport: ChatBundle[] = [];
  let updated = 0;
  let skipped = 0;
  const localTs = options.localImportTimestamps ?? new Map<string, number>();

  for (const bundle of remoteBundles) {
    const isLocal = localConversationIds.has(bundle.conversationId);
    if (!isLocal) {
      toImport.push(bundle);
      continue;
    }
    if (options.policy === "remoteWins") {
      toImport.push(bundle);
      updated += 1;
      continue;
    }
    if (options.policy === "newerWins") {
      const remoteTs = bundleTimestamp(bundle);
      const localImportedTs = localTs.get(bundle.conversationId) ?? 0;
      if (remoteTs > localImportedTs) {
        toImport.push(bundle);
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    skipped += 1;
  }

  return { toImport, updated, skipped };
}

export function selectChatsToPull(
  remoteBundles: ChatBundle[],
  localConversationIds: Set<string>
): ChatBundle[] {
  return selectChatsForPull(remoteBundles, localConversationIds, {
    pullUpdates: false,
    policy: "skip",
  }).toImport;
}

export function collectionJsonFromBundles(bundles: ChatBundle[]): string {
  const collection = nativeCollectionFromBundles(bundles);
  return JSON.stringify(collection, null, 2);
}

/** @deprecated Use {@link collectionJsonFromBundles} (native cursor-chat-collection). */
export function legacyCollectionJsonFromBundles(bundles: ChatBundle[]): string {
  const collection = buildChatBundlesCollection("multi", bundles);
  return JSON.stringify(collection, null, 2);
}

export interface ParsedSyncChatCollection {
  format: "native" | "legacy";
  bundles: ChatBundle[];
}

export function parseSyncChatCollection(raw: string): ParsedSyncChatCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid sync chat JSON: ${msg}`);
  }
  if (isNativeChatCollection(parsed)) {
    return { format: "native", bundles: bundlesFromNativeCollection(parsed) };
  }
  if (isNativeChatJsonDocument(parsed)) {
    return { format: "native", bundles: [chatBundleFromNativeChatJson(parsed)] };
  }
  const legacy = parseChatBundleOrCollection(raw);
  if (legacy.kind !== "collection") {
    throw new Error("Expected cursor-chat-collection or chat-bundles-collection in sync gist.");
  }
  return { format: "legacy", bundles: legacy.collection.bundles };
}

/** @deprecated Use {@link parseSyncChatCollection}. */
export function parseChatCollectionFromPlaintext(raw: string): ChatBundlesCollection {
  const sync = parseSyncChatCollection(raw);
  return buildChatBundlesCollection("multi", sync.bundles);
}

export function computeChatCollectionChecksum(content: string): string {
  return computeChecksum(Buffer.from(content, "utf-8"));
}

export async function decryptGistChatContent(
  context: vscode.ExtensionContext,
  raw: string
): Promise<string> {
  if (!isEncryptedChatGistPayload(raw)) {
    return raw;
  }
  const password = await requireChatEncryptionPassword(context, "import-envelope");
  if (!password) {
    throw new Error("Chat encryption password required to decrypt synced chats.");
  }
  try {
    const plaintext = await decryptChatGistPayload(raw, password);
    await setChatEncryptionPassword(context, password);
    return plaintext;
  } catch (err) {
    if (err instanceof ChatGistCryptoError && err.code === "DECRYPT_FAILED") {
      await clearChatEncryptionPassword(context);
      throw new Error(
        "Could not decrypt synced chats. Set your chat encryption password (Cursor Sync: Set Chat Encryption Password)."
      );
    }
    throw err;
  }
}

export async function encryptCollectionForGist(
  context: vscode.ExtensionContext,
  plaintext: string
): Promise<string> {
  if (!isChatGistEncryptionEnabled()) {
    return plaintext;
  }
  const password = await requireChatEncryptionPassword(context, "export");
  if (!password) {
    throw new Error("Chat encryption password required to upload synced chats.");
  }
  return encryptChatGistPayload(plaintext, password, "cursor-chat-collection");
}

async function fetchSyncChatRawFromFiles(
  files: Record<string, string>
): Promise<{ raw: string; fileName: string } | null> {
  const nativeRaw = files[CURSOR_CHAT_GIST_FILE_NAME];
  if (nativeRaw !== undefined) {
    return { raw: nativeRaw, fileName: CURSOR_CHAT_GIST_FILE_NAME };
  }
  const legacyRaw = files[CHAT_BUNDLES_GIST_FILE_NAME];
  if (legacyRaw !== undefined) {
    return { raw: legacyRaw, fileName: CHAT_BUNDLES_GIST_FILE_NAME };
  }
  return null;
}

export async function fetchRemoteChatCollectionFromFiles(
  context: vscode.ExtensionContext,
  files: Record<string, string>
): Promise<ChatBundle[] | null> {
  const fetched = await fetchSyncChatRawFromFiles(files);
  if (!fetched) {
    return null;
  }
  const plaintext = await decryptGistChatContent(context, fetched.raw);
  const collection = parseSyncChatCollection(plaintext);
  if (collection.format === "legacy" && fetched.fileName === CHAT_BUNDLES_GIST_FILE_NAME) {
    getLogger().appendLine(
      `[${new Date().toISOString()}] [chat-sync] read legacy ${CHAT_BUNDLES_GIST_FILE_NAME}; next push will use ${CURSOR_CHAT_GIST_FILE_NAME}`
    );
  }
  return collection.bundles;
}

export async function fetchRemoteChatCollection(
  context: vscode.ExtensionContext,
  gistId: string,
  token: string
): Promise<ChatBundle[] | null> {
  const syncState = await loadSyncState(context);
  const backend =
    createRemoteBackend(context, token, syncState) ??
    new GistBackend(token, gistId);
  const snap = await backend.getSnapshot();
  if (!snap.ok) {
    throw new Error(snap.error.message);
  }
  return fetchRemoteChatCollectionFromFiles(context, snap.data.files);
}

export async function buildChatCollectionForSync(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string; increment?: number }> = noopChatSyncProgress
): Promise<{ bundles: ChatBundle[]; warnings: string[] }> {
  const logger = getLogger();
  const warnings: string[] = [];
  const discovered = await discoverBackupEligibleConversations();
  if (discovered.length === 0) {
    return { bundles: [], warnings };
  }

  const byWorkspace = new Map<string, string[]>();
  for (const item of discovered) {
    const key = item.workspaceKey || "";
    const list = byWorkspace.get(key) ?? [];
    list.push(item.conversationId);
    byWorkspace.set(key, list);
  }

  const bundles: ChatBundle[] = [];
  const maxBytes = getChatCollectionMaxBytes();
  let runningBytes = 0;

  for (const [workspaceKey, conversationIds] of byWorkspace) {
    for (const conversationId of conversationIds) {
      progress.report({ message: `Packaging chat ${conversationId.slice(0, 8)}…` });
      try {
        const built = await buildChatBundle(context, conversationId, progress, {
          workspaceKey: workspaceKey || undefined,
        });
        const { bundle: enriched, warnings: enrichW } = await enrichBundleWithLiveDiskKv(
          built.bundle,
          { retries: SQLITE_READ_RETRIES, extensionPath: context.extensionUri?.fsPath }
        );
        if (!isBundleSyncEligible(enriched, isChatSyncOnlyFullBackups())) {
          const msg = `Skipped chat ${conversationId}: below minimum backup tier (syncOnlyFullBackups=${isChatSyncOnlyFullBackups()}).`;
          warnings.push(msg);
          logger.appendLine(`[${new Date().toISOString()}] [chat-sync] ${msg}`);
          continue;
        }
        const approxSize = JSON.stringify(enriched).length;
        if (maxBytes > 0 && runningBytes + approxSize > maxBytes) {
          const msg = `Skipped chat ${conversationId}: collection size limit (${maxBytes} bytes).`;
          warnings.push(msg);
          logger.appendLine(`[${new Date().toISOString()}] [chat-sync] ${msg}`);
          continue;
        }
        runningBytes += approxSize;
        bundles.push(enriched);
        warnings.push(...built.warnings, ...enrichW);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Skipped chat ${conversationId}: ${msg}`);
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-sync] skip conversationId=${conversationId}: ${msg}`
        );
      }
    }
  }

  return { bundles, warnings };
}
