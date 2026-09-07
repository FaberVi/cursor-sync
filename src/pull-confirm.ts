import { runGit } from "./git-cli.js";
import {
  skillFolderDisplayName,
  skillFolderPrefix,
} from "./sync-skill-folders.js";
import { CURSOR_CHAT_SYNC_KEY } from "./chat-sync-collection.js";
import { CURSOR_CHAT_GIST_FILE_NAME } from "./chat-bundle-format.js";

const MANIFEST_NAME = "manifest.json";

export type IncomingCommitSummary = {
  subjects: string[];
  incomingSyncKeys: string[];
  incomingDisplayNames: string[];
};

export function syncKeysFromDiffNameOnly(stdout: string, basePath: string): string[] {
  const keys = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const syncKey = cloneDiffPathToSyncKey(trimmed, basePath);
    if (syncKey) {
      keys.add(syncKey);
    }
  }
  return [...keys].sort();
}

export function cloneDiffPathToSyncKey(
  repoRelativePath: string,
  basePath: string
): string | undefined {
  const posix = repoRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const prefix = `${basePath.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  if (!posix.startsWith(prefix)) {
    return undefined;
  }
  const rest = posix.slice(prefix.length);
  if (!rest.startsWith("cursor-user/") && !rest.startsWith("dot-cursor/")) {
    if (rest === MANIFEST_NAME || rest === CURSOR_CHAT_GIST_FILE_NAME) {
      return undefined;
    }
    return undefined;
  }
  if (rest === CURSOR_CHAT_SYNC_KEY || rest.endsWith(`/${MANIFEST_NAME}`)) {
    return undefined;
  }
  if (rest.endsWith(`/${CURSOR_CHAT_GIST_FILE_NAME}`) || rest === CURSOR_CHAT_GIST_FILE_NAME) {
    return undefined;
  }
  return rest;
}

export function displayNamesForSyncKeys(keys: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const prefix = skillFolderPrefix(key);
    const label = prefix ? skillFolderDisplayName(prefix) : conflictPathTail(key);
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    names.push(label);
  }
  return names;
}

function conflictPathTail(syncKey: string): string {
  if (syncKey.startsWith("dot-cursor/")) {
    return syncKey.slice("dot-cursor/".length);
  }
  if (syncKey.startsWith("cursor-user/")) {
    return syncKey.slice("cursor-user/".length);
  }
  return syncKey;
}

export function listLocalOnlyKeys(options: {
  localKeys: readonly string[];
  remoteChecksums: Record<string, string>;
  previousRemoteChecksums: Record<string, string>;
}): string[] {
  const remote = new Set(Object.keys(options.remoteChecksums));
  const previous = new Set(Object.keys(options.previousRemoteChecksums));
  return options.localKeys
    .filter((key) => !remote.has(key) && !previous.has(key))
    .filter((key) => key !== CURSOR_CHAT_SYNC_KEY)
    .sort();
}

export async function readIncomingCommitSummary(options: {
  clonePath: string;
  basePath: string;
  preSha: string;
}): Promise<IncomingCommitSummary> {
  let subjects: string[] = [];
  try {
    const log = await runGit({
      args: ["log", "--oneline", "-5", `${options.preSha}..HEAD`],
      cwd: options.clonePath,
    });
    subjects = log.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[0-9a-f]{7,40}\s+/i, ""));
  } catch {
    subjects = [];
  }

  let incomingSyncKeys: string[] = [];
  try {
    const diff = await runGit({
      args: ["diff", "--name-only", options.preSha, "HEAD"],
      cwd: options.clonePath,
    });
    incomingSyncKeys = syncKeysFromDiffNameOnly(diff.stdout, options.basePath);
  } catch {
    incomingSyncKeys = [];
  }

  return {
    subjects,
    incomingSyncKeys,
    incomingDisplayNames: displayNamesForSyncKeys(incomingSyncKeys),
  };
}

export type SyncConfirmMode =
  | "syncNow"
  | "pullMirror"
  | "resetMirror"
  | "chatsOnly";

export type SyncConfirmModel = {
  mode: SyncConfirmMode;
  incoming: IncomingCommitSummary;
  localOnlyKeys: readonly string[];
  conflictKeys: readonly string[];
  n: number;
  m: number;
  k: number;
};

export function buildSyncConfirmModel(input: {
  mode: SyncConfirmMode;
  incoming: IncomingCommitSummary;
  localOnlyKeys?: readonly string[];
  conflictKeys?: readonly string[];
  n: number;
  m: number;
  k?: number;
}): SyncConfirmModel {
  return {
    mode: input.mode,
    incoming: input.incoming,
    localOnlyKeys: input.localOnlyKeys ?? [],
    conflictKeys: input.conflictKeys ?? [],
    n: input.n,
    m: input.m,
    k: input.k ?? 0,
  };
}
