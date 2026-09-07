import { runGit } from "./git-cli.js";
import { t } from "./sidebar/i18n.js";
import {
  skillFolderDisplayName,
  skillFolderPrefix,
} from "./sync-skill-folders.js";
import { CURSOR_CHAT_SYNC_KEY } from "./chat-sync-collection.js";
import { CURSOR_CHAT_GIST_FILE_NAME } from "./chat-bundle-format.js";

export const PULL_CONFIRM_NAME_CAP = 8;

const MANIFEST_NAME = "manifest.json";

export type IncomingCommitSummary = {
  subjects: string[];
  incomingSyncKeys: string[];
  incomingDisplayNames: string[];
};

export function formatNameList(names: readonly string[], cap = PULL_CONFIRM_NAME_CAP): string {
  if (names.length === 0) {
    return "";
  }
  if (names.length <= cap) {
    return names.join(", ");
  }
  const shown = names.slice(0, cap);
  const extra = names.length - cap;
  return `${shown.join(", ")}, ${t("andNMore", { n: extra })}`;
}

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

export function buildSyncNowConfirmMessage(options: {
  incoming: IncomingCommitSummary;
  localOnlyKeys: readonly string[];
  conflictCount: number;
  n: number;
  m: number;
}): string {
  const parts: string[] = [];
  if (options.incoming.subjects.length > 0) {
    parts.push(
      t("originAheadCommits", {
        n: options.incoming.subjects.length,
        commits: formatNameList(options.incoming.subjects, 5),
      })
    );
  }
  if (options.incoming.incomingDisplayNames.length > 0) {
    parts.push(
      t("incomingChanges", {
        files: formatNameList(options.incoming.incomingDisplayNames),
      })
    );
  } else {
    parts.push(t("incomingNoSkillFolders"));
  }
  const kept = displayNamesForSyncKeys(options.localOnlyKeys);
  if (kept.length > 0) {
    parts.push(t("localOnlyKept", { files: formatNameList(kept) }));
  }
  if (options.conflictCount > 0) {
    parts.push(t("conflictsWillOpenTab", { n: options.conflictCount }));
  }
  parts.push(t("syncNowCounts", { n: options.n, m: options.m }));
  return parts.join(" ");
}

export function buildPullMirrorConfirmMessage(options: {
  incoming: IncomingCommitSummary;
  localOnlyKeys: readonly string[];
  n: number;
  m: number;
  k: number;
  reset: boolean;
}): string {
  const parts: string[] = [
    options.reset ? t("resetMirrorLead") : t("pullMirrorLead"),
  ];
  if (options.incoming.subjects.length > 0) {
    parts.push(
      t("originAheadCommits", {
        n: options.incoming.subjects.length,
        commits: formatNameList(options.incoming.subjects, 5),
      })
    );
  }
  if (options.incoming.incomingDisplayNames.length > 0) {
    parts.push(
      t("incomingChanges", {
        files: formatNameList(options.incoming.incomingDisplayNames),
      })
    );
  }
  const deleted = displayNamesForSyncKeys(options.localOnlyKeys);
  if (deleted.length > 0) {
    parts.push(t("localOnlyDeleted", { files: formatNameList(deleted) }));
  }
  parts.push(
    t("pullMirrorCounts", { n: options.n, m: options.m, k: options.k })
  );
  return parts.join(" ");
}
