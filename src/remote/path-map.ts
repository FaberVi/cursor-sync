/**
 * Gist file names stay flat (`/` → `--`). Repo Git paths under `basePath` use
 * real directories; only the RepoBackend boundary translates.
 */
import {
  gistFileNameToSyncKey,
  syncKeyToGistFileName,
} from "../paths.js";

export {
  syncKeyToGistFileName as syncKeyToRemoteFileName,
  gistFileNameToSyncKey as remoteFileNameToSyncKey,
} from "../paths.js";

/** Leftover gist-flat file still stored at `basePath` root (legacy `--` layout). */
export type LeftoverDashedFile = {
  dashedRelative: string;
  blobSha: string;
  remoteName: string;
  nestedPresent: boolean;
};

export function joinRemotePath(basePath: string, fileName: string): string {
  const base = basePath.replace(/^\/+|\/+$/g, "");
  const name = fileName.replace(/^\/+/, "");
  return base ? `${base}/${name}` : name;
}

export function stripRemotePath(basePath: string, fullPath: string): string | undefined {
  const base = basePath.replace(/^\/+|\/+$/g, "");
  const normalized = fullPath.replace(/^\/+/, "");
  if (!base) {
    return normalized;
  }
  const prefix = `${base}/`;
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }
  return normalized.slice(prefix.length);
}

/** Gist-flat remote name → Git relative path under `basePath` (nested for `--` keys). */
export function remoteNameToGitRelative(name: string): string {
  return gistFileNameToSyncKey(name);
}

/**
 * Git relative path under `basePath` → gist-flat remote name.
 * Nested paths encode `/` as `--`; legacy dashed files at root stay as-is.
 */
export function gitRelativeToRemoteName(relative: string): string {
  return relative.includes("/") ? syncKeyToGistFileName(relative) : relative;
}

export function repoGitPath(basePath: string, remoteName: string): string {
  return joinRemotePath(basePath, remoteNameToGitRelative(remoteName));
}

export function isLegacyDashedRelative(relative: string): boolean {
  return !relative.includes("/") && relative.includes("--");
}
