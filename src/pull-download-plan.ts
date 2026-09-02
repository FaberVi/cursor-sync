import {
  isExcludedSyncKey,
  isMcpSyncEnabled,
  isMcpSyncKey,
  syncKeyToGistFileName,
} from "./paths.js";

export const EXTENSIONS_GIST_FILE_NAME = "cursor-user--extensions.json";
export const EXTENSIONS_SYNC_KEY = "cursor-user/extensions.json";

export type ChatGistFile = {
  syncKey: string;
  gistName: string;
};

export function planPullDownloadNames(options: {
  manifestChecksums: Record<string, string>;
  localChecksums: Record<string, string>;
  allFileNames: readonly string[];
  keepLocalKeys: ReadonlySet<string>;
  chatEnabled: boolean;
  chatFiles: readonly ChatGistFile[];
}): string[] {
  const present = new Set(options.allFileNames);
  const chatSyncKeys = new Set(options.chatFiles.map((file) => file.syncKey));
  const names = new Set<string>();

  for (const [syncKey, remoteChecksum] of Object.entries(options.manifestChecksums)) {
    if (options.keepLocalKeys.has(syncKey)) {
      continue;
    }
    if (isExcludedSyncKey(syncKey)) {
      continue;
    }
    if (!isMcpSyncEnabled() && isMcpSyncKey(syncKey)) {
      continue;
    }
    if (chatSyncKeys.has(syncKey)) {
      continue;
    }
    const localChecksum = options.localChecksums[syncKey];
    if (localChecksum && localChecksum === remoteChecksum) {
      continue;
    }
    const gistName = syncKeyToGistFileName(syncKey);
    if (gistName === "manifest.json") {
      continue;
    }
    if (present.has(gistName)) {
      names.add(gistName);
    }
  }

  if (options.chatEnabled) {
    for (const { syncKey, gistName } of options.chatFiles) {
      if (options.keepLocalKeys.has(syncKey)) {
        continue;
      }
      if (!present.has(gistName)) {
        continue;
      }
      const remoteChecksum = options.manifestChecksums[syncKey];
      if (!remoteChecksum) {
        continue;
      }
      const localChecksum = options.localChecksums[syncKey];
      if (localChecksum && localChecksum === remoteChecksum) {
        continue;
      }
      names.add(gistName);
    }
  }

  if (
    present.has(EXTENSIONS_GIST_FILE_NAME) &&
    !options.keepLocalKeys.has(EXTENSIONS_SYNC_KEY)
  ) {
    names.add(EXTENSIONS_GIST_FILE_NAME);
  }

  return [...names].sort();
}
