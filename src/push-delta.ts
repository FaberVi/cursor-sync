import { syncKeyToGistFileName } from "./paths.js";
import type { PackagedFile } from "./types.js";

export interface PushDeltaInput {
  packaged: Map<string, PackagedFile>;
  /** Remote checksums keyed by sync key (from manifest or sync state). */
  remoteChecksums: Record<string, string>;
  /** Flat remote file names currently on the remote (from snapshot). */
  existingRemoteNames: string[];
  /** When true, upload every packaged file (first push / empty remote). */
  forceFullUpload: boolean;
  chat?: {
    syncKey: string;
    gistFileName: string;
    checksum: string;
    content: string;
  };
  /** Prefer native chat file name when deleting the legacy bundles file. */
  pushNativeChatFile?: boolean;
  chatSyncEnabled?: boolean;
  legacyChatBundlesFileName?: string;
}

export interface PushDeltaResult {
  /** Files to upload (flat gist/repo names → content). Does not include manifest. */
  filesToUpload: Record<string, string>;
  /** Sync keys (or chat sync key) included in the upload. */
  uploadedSyncKeys: string[];
  unchangedCount: number;
  deleteNames: string[];
  /** True when nothing to upload and nothing to delete. */
  isNoOp: boolean;
}

/**
 * Select only changed/new files for upload, plus remote deletes for removed locals.
 * Manifest is handled by the caller (always rewritten when not a no-op).
 */
export function selectPushDelta(input: PushDeltaInput): PushDeltaResult {
  const {
    packaged,
    remoteChecksums,
    existingRemoteNames,
    forceFullUpload,
    chat,
    pushNativeChatFile = false,
    chatSyncEnabled = false,
    legacyChatBundlesFileName,
  } = input;

  const filesToUpload: Record<string, string> = {};
  const uploadedSyncKeys: string[] = [];
  let unchangedCount = 0;

  for (const [syncKey, packagedFile] of packaged) {
    const remoteChecksum = remoteChecksums[syncKey];
    const changed =
      forceFullUpload ||
      remoteChecksum === undefined ||
      remoteChecksum !== packagedFile.checksum;
    if (changed) {
      filesToUpload[syncKeyToGistFileName(syncKey)] = packagedFile.content;
      uploadedSyncKeys.push(syncKey);
    } else {
      unchangedCount += 1;
    }
  }

  if (chat) {
    const remoteChatChecksum = remoteChecksums[chat.syncKey];
    const chatChanged =
      forceFullUpload ||
      remoteChatChecksum === undefined ||
      remoteChatChecksum !== chat.checksum;
    if (chatChanged) {
      filesToUpload[chat.gistFileName] = chat.content;
      uploadedSyncKeys.push(chat.syncKey);
    } else {
      unchangedCount += 1;
    }
  }

  const localRemoteNames = new Set<string>([
    "manifest.json",
    ...[...packaged.keys()].map(syncKeyToGistFileName),
  ]);
  if (chat) {
    localRemoteNames.add(chat.gistFileName);
  }

  const deleteNames: string[] = [];
  for (const existing of existingRemoteNames) {
    if (existing === "manifest.json" || localRemoteNames.has(existing)) {
      continue;
    }
    if (
      legacyChatBundlesFileName &&
      existing === legacyChatBundlesFileName &&
      !chatSyncEnabled
    ) {
      continue;
    }
    deleteNames.push(existing);
  }
  if (
    pushNativeChatFile &&
    legacyChatBundlesFileName &&
    !deleteNames.includes(legacyChatBundlesFileName)
  ) {
    deleteNames.push(legacyChatBundlesFileName);
  }

  const isNoOp =
    !forceFullUpload &&
    Object.keys(filesToUpload).length === 0 &&
    deleteNames.length === 0;

  return {
    filesToUpload,
    uploadedSyncKeys,
    unchangedCount,
    deleteNames,
    isNoOp,
  };
}
