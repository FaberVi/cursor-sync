import * as vscode from "vscode";
import { enumerateSyncFiles, resolveSyncRoots } from "./paths.js";
import { selectPushDelta, type PushDeltaResult } from "./push-delta.js";
import type { SyncProgressReport } from "./sync-progress-events.js";
import type { ManifestFileEntry, SyncState } from "./types.js";
import type { RemoteSyncBackend } from "./remote/index.js";
import type { Manifest, PackagedFile } from "./types.js";
import { getLogger } from "./diagnostics.js";
import { withRetry } from "./retry.js";
import { packageFiles } from "./packaging.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import {
  cacheLastRemoteExtensions,
  generateExtensionsJson,
  parseExtensionEntries,
  writeExtensionsFile,
} from "./extensions.js";
import { migrateAndLogSkillArtifacts } from "./skill-artifacts-migrate.js";
import {
  CURSOR_CHAT_GIST_FILE_NAME,
  CURSOR_CHAT_SYNC_KEY,
  canSkipChatPackaging,
  fetchRemoteChatCollectionFromFiles,
  formatChatSyncFidelityToast,
  isChatSyncEnabled,
  prepareChatSyncPushPayload,
} from "./chat-sync.js";

export type PushChatForDelta = {
  syncKey: string;
  gistFileName: string;
  checksum: string;
  content: string;
};

export type PushPackageResult = {
  packaged: Map<string, PackagedFile>;
  manifest: Manifest;
  delta: PushDeltaResult;
  chatForDelta: PushChatForDelta | undefined;
  chatBundleCount: number;
};

export async function packagePushFiles(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<SyncProgressReport> & { percent?: number },
  backend: RemoteSyncBackend,
  syncState: SyncState | undefined,
  remoteChecksums: Record<string, string>,
  remoteManifestFiles: Record<string, ManifestFileEntry>,
  existingRemoteNames: string[],
  forceFullUpload: boolean,
  keepRemoteKeys: Set<string>
): Promise<PushPackageResult> {
  const logger = getLogger();

  progress.report({ message: "Packaging local files…" });
  const extensionsKey = "cursor-user/extensions.json";
  if (!keepRemoteKeys.has(extensionsKey)) {
    const extensionsJson = generateExtensionsJson();
    try {
      const parsed = parseExtensionEntries(JSON.parse(extensionsJson));
      if (parsed) {
        await cacheLastRemoteExtensions(context, parsed);
      }
    } catch {
      // Cache is best-effort; push must still upload.
    }
    const cursorUserRoot = resolveSyncRoots().cursorUser;
    await writeExtensionsFile(cursorUserRoot, extensionsJson);
  }

  await migrateAndLogSkillArtifacts();

  const files = await enumerateSyncFiles();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const profileName = config.get<string>("syncProfileName") ?? "default";
  const { packaged, manifest, skipped } = await packageFiles(files, profileName);
  if (skipped.length > 0) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skipping ${skipped.length} empty/whitespace-only file(s) (GitHub Gist rejects them):`
    );
    for (const item of skipped) {
      logger.appendLine(`  - ${item.relativeSyncKey} (${item.reason})`);
    }
  }

  for (const key of keepRemoteKeys) {
    packaged.delete(key);
    const remoteChecksum = remoteChecksums[key];
    if (remoteChecksum) {
      const remoteEntry = remoteManifestFiles[key];
      manifest.files[key] = {
        checksum: remoteChecksum,
        sizeBytes: remoteEntry?.sizeBytes ?? 0,
      };
    } else {
      delete manifest.files[key];
    }
  }

  let chatBundleCount = 0;
  let pushNativeChatFile = false;
  let chatForDelta: PushChatForDelta | undefined;
  if (isChatSyncEnabled()) {
    const skipChat = await canSkipChatPackaging(
      context,
      remoteChecksums,
      syncState ?? undefined
    );
    if (skipChat) {
      progress.report({ message: "Chat backup unchanged…" });
      const remoteEntry = remoteManifestFiles[CURSOR_CHAT_SYNC_KEY];
      const checksum = remoteChecksums[CURSOR_CHAT_SYNC_KEY]!;
      manifest.files[CURSOR_CHAT_SYNC_KEY] = {
        checksum,
        sizeBytes: remoteEntry?.sizeBytes ?? 0,
      };
      chatForDelta = {
        syncKey: CURSOR_CHAT_SYNC_KEY,
        gistFileName: CURSOR_CHAT_GIST_FILE_NAME,
        checksum,
        content: "",
      };
      pushNativeChatFile = true;
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-sync] skipped packaging (fingerprint unchanged)`
      );
    } else {
      progress.report({ message: "Preparing chat backup…" });
      try {
        const chatPayload = await prepareChatSyncPushPayload(
          context,
          async () => {
            const chatSnap = await withRetry(() =>
              backend.getSnapshot({
                onlyFiles: [
                  CURSOR_CHAT_GIST_FILE_NAME,
                  CHAT_BUNDLES_GIST_FILE_NAME,
                ],
              })
            );
            if (!chatSnap.ok) {
              return null;
            }
            return fetchRemoteChatCollectionFromFiles(
              context,
              chatSnap.data.files
            );
          },
          { report: (value: { message?: string; increment?: number }) => progress.report(value) }
        );
        if (chatPayload) {
          manifest.files[chatPayload.syncKey] = {
            checksum: chatPayload.checksum,
            sizeBytes: chatPayload.sizeBytes,
          };
          chatBundleCount = chatPayload.bundleCount;
          pushNativeChatFile =
            chatPayload.gistFileName === CURSOR_CHAT_GIST_FILE_NAME;
          chatForDelta = {
            syncKey: chatPayload.syncKey,
            gistFileName: chatPayload.gistFileName,
            checksum: chatPayload.checksum,
            content: chatPayload.content,
          };
          const fidelity = chatPayload.fidelityReport;
          const lowTier =
            fidelity.byTier.archive + fidelity.byTier.partial;
          if (lowTier > 0 || fidelity.textOnlyLayer4 > 0) {
            const detail = formatChatSyncFidelityToast(fidelity);
            logger.appendLine(
              `[${new Date().toISOString()}] [chat-sync] push fidelity: ${detail}`
            );
            void vscode.window
              .showWarningMessage(
                `Chat sync: ${detail}. See Output for details.`,
                "Show Output"
              )
              .then((choice) => {
                if (choice === "Show Output") {
                  logger.show();
                }
              });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(
          `[${new Date().toISOString()}] Push chat sync skipped: ${msg}`
        );
        vscode.window.showWarningMessage(
          `Settings push continues; chat sync skipped: ${msg}`
        );
      }
    }
  }

  const delta = selectPushDelta({
    packaged,
    remoteChecksums,
    existingRemoteNames,
    forceFullUpload,
    chat: chatForDelta,
    pushNativeChatFile,
    chatSyncEnabled: isChatSyncEnabled(),
    legacyChatBundlesFileName: CHAT_BUNDLES_GIST_FILE_NAME,
    preserveSyncKeys: keepRemoteKeys,
  });

  return { packaged, manifest, delta, chatForDelta, chatBundleCount };
}
