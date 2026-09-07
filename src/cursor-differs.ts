import type * as vscode from "vscode";
import {
  computeChatSyncLocalFingerprint,
  isChatSyncEnabled,
  readStoredChatSyncFingerprint,
  CURSOR_CHAT_SYNC_KEY,
} from "./chat-sync.js";
import { loadSyncState } from "./diagnostics.js";
import { computeChecksum } from "./packaging.js";
import type { GitRelation } from "./sync-clone.js";
import {
  hashCloneSyncFiles,
  hashCursorSyncFiles,
  readCloneChatRaw,
} from "./sync-copy.js";

export type SyncCardStatus =
  | "synced"
  | "not-synced"
  | "syncing"
  | "error"
  | "loading"
  | "behind"
  | "diverged";

export type FileChangeKind = "added" | "modified" | "removed";

export type SyncKeyChange = {
  syncKey: string;
  change: FileChangeKind;
};

export function listHashDiffs(
  local: Record<string, string>,
  clone: Record<string, string>
): SyncKeyChange[] {
  const keys = [...new Set([...Object.keys(local), ...Object.keys(clone)])].sort();
  const out: SyncKeyChange[] = [];
  for (const syncKey of keys) {
    const left = local[syncKey];
    const right = clone[syncKey];
    if (left === right) {
      continue;
    }
    if (left && !right) {
      out.push({ syncKey, change: "added" });
    } else if (!left && right) {
      out.push({ syncKey, change: "removed" });
    } else {
      out.push({ syncKey, change: "modified" });
    }
  }
  return out;
}

let localDiffers: boolean | undefined;

export function getLocalDiffersCache(): boolean | undefined {
  return localDiffers;
}

export function recordLocalDiffers(value: boolean): void {
  localDiffers = value;
}

export function __resetLocalDiffersForTests(): void {
  localDiffers = undefined;
}

/**
 * Compare Cursor sync files (and chat fingerprint when enabled) to the clone.
 * Hash failures count as differs so the UI never claims Synced on error.
 */
export async function computeCursorDiffers(
  context: vscode.ExtensionContext,
  clonePath: string,
  basePath: string
): Promise<boolean> {
  const syncState = await loadSyncState(context);
  const localHashes = await hashCursorSyncFiles();
  const cloneHashes = await hashCloneSyncFiles(clonePath, basePath);
  let cursorDiffers = listHashDiffs(localHashes, cloneHashes).length > 0;

  if (isChatSyncEnabled()) {
    const fingerprint = await computeChatSyncLocalFingerprint();
    const stored = await readStoredChatSyncFingerprint(context);
    const cloneChat = await readCloneChatRaw(clonePath, basePath);
    const cloneChatChecksum = cloneChat
      ? computeChecksum(Buffer.from(cloneChat, "utf8"))
      : undefined;
    const lastChat = syncState?.localChecksums[CURSOR_CHAT_SYNC_KEY];
    if (stored !== fingerprint || lastChat !== cloneChatChecksum) {
      cursorDiffers = true;
    }
  }
  return cursorDiffers;
}

export function resolveSyncCardStatus(input: {
  status: SyncCardStatus;
  relation: GitRelation | undefined;
  hasSyncState: boolean;
  cursorDiffers: boolean | undefined;
}): SyncCardStatus {
  if (
    input.status === "loading" ||
    input.status === "syncing" ||
    input.status === "error"
  ) {
    return input.status;
  }
  if (input.relation === "diverged") {
    return "diverged";
  }
  if (input.relation === "behind") {
    return "behind";
  }
  if (
    !input.hasSyncState ||
    input.cursorDiffers !== false ||
    input.relation === "ahead" ||
    input.relation === "empty"
  ) {
    return "not-synced";
  }
  return "synced";
}
