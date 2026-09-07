import * as vscode from "vscode";
import {
  computeChatSyncLocalFingerprint,
  isChatSyncEnabled,
  readStoredChatSyncFingerprint,
  CURSOR_CHAT_SYNC_KEY,
} from "./chat-sync.js";
import { loadSyncState } from "./diagnostics.js";
import { computeChecksum } from "./packaging.js";
import { runGit } from "./git-cli.js";
import { syncKeysFromDiffNameOnly } from "./pull-confirm.js";
import { getRemoteAheadCache } from "./remote-ahead.js";
import { getSyncClonePath, readRepoIdentity } from "./sync-clone.js";
import {
  hashCloneSyncFiles,
  hashCursorSyncFiles,
  readCloneChatRaw,
} from "./sync-copy.js";
import {
  listHashDiffs,
} from "./cursor-differs.js";
import type { SyncKeyPreviewEntry } from "./sync-key-picker.js";

export const STATUS_PREVIEW_KINDS = ["local", "incoming", "localOnly", "diverged"] as const;

export type StatusPreviewKind = (typeof STATUS_PREVIEW_KINDS)[number];

export function isStatusPreviewKind(value: string | undefined): value is StatusPreviewKind {
  return (STATUS_PREVIEW_KINDS as readonly string[]).includes(value ?? "");
}

async function gitDiffSyncKeys(
  clonePath: string,
  basePath: string,
  range: string
): Promise<string[]> {
  const diff = await runGit({
    args: ["diff", "--name-only", range],
    cwd: clonePath,
  });
  return syncKeysFromDiffNameOnly(diff.stdout, basePath);
}

async function listUnpushedEntries(
  clonePath: string,
  basePath: string,
  branch: string
): Promise<SyncKeyPreviewEntry[]> {
  try {
    const keys = await gitDiffSyncKeys(clonePath, basePath, `origin/${branch}...HEAD`);
    return keys.map((syncKey) => ({ syncKey, change: "modified" as const }));
  } catch {
    return [];
  }
}

export async function listStatusPreviewEntries(
  context: vscode.ExtensionContext,
  kind: StatusPreviewKind
): Promise<SyncKeyPreviewEntry[]> {
  const identity = readRepoIdentity();
  if (!identity) {
    return [];
  }
  const clonePath = getSyncClonePath(context);
  const originRef = `origin/${identity.branch}`;

  if (kind === "incoming") {
    try {
      const keys = await gitDiffSyncKeys(
        clonePath,
        identity.basePath,
        `HEAD...${originRef}`
      );
      return keys.map((syncKey) => ({
        syncKey,
        change: "incoming" as const,
      }));
    } catch {
      return [];
    }
  }

  if (kind === "diverged") {
    try {
      const diff = await runGit({
        args: ["diff", "--name-only", "HEAD", originRef],
        cwd: clonePath,
      });
      return syncKeysFromDiffNameOnly(diff.stdout, identity.basePath).map((syncKey) => ({
        syncKey,
        change: "modified" as const,
      }));
    } catch {
      return [];
    }
  }

  const localHashes = await hashCursorSyncFiles();
  const cloneHashes = await hashCloneSyncFiles(clonePath, identity.basePath);

  if (kind === "localOnly") {
    return Object.keys(localHashes)
      .filter((key) => !cloneHashes[key] && key !== CURSOR_CHAT_SYNC_KEY)
      .sort()
      .map((syncKey) => ({ syncKey, change: "added" as const }));
  }

  const diffs: SyncKeyPreviewEntry[] = listHashDiffs(localHashes, cloneHashes);
  if (isChatSyncEnabled()) {
    const syncState = await loadSyncState(context);
    const fingerprint = await computeChatSyncLocalFingerprint();
    const stored = await readStoredChatSyncFingerprint(context);
    const cloneChat = await readCloneChatRaw(clonePath, identity.basePath);
    const cloneChatChecksum = cloneChat
      ? computeChecksum(Buffer.from(cloneChat, "utf8"))
      : undefined;
    const lastChat = syncState?.localChecksums[CURSOR_CHAT_SYNC_KEY];
    if (stored !== fingerprint || lastChat !== cloneChatChecksum) {
      if (!diffs.some((row) => row.syncKey === CURSOR_CHAT_SYNC_KEY)) {
        diffs.push({ syncKey: CURSOR_CHAT_SYNC_KEY, change: "modified" });
      }
    }
  }
  if (diffs.length > 0) {
    return diffs;
  }
  const relation = getRemoteAheadCache()?.relation;
  if (relation === "ahead" || relation === "empty") {
    return listUnpushedEntries(clonePath, identity.basePath, identity.branch);
  }
  return diffs;
}

export async function showStatusPreview(
  context: vscode.ExtensionContext,
  kind: StatusPreviewKind
): Promise<void> {
  const { openStatusPreviewPanel } = await import("./status-preview-panel.js");
  await openStatusPreviewPanel(context, kind);
}
