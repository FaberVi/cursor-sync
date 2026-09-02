import { commandTitle } from "../extension-branding.js";
import { githubRequest } from "./github-api.js";
import {
  joinRemotePath,
  remoteNameToGitRelative,
  repoGitPath,
  type LeftoverDashedFile,
} from "./path-map.js";
import { withRetry } from "../retry.js";
import type { ApiError, ApiResult } from "../types.js";
import type { RemoteWriteResult } from "./types.js";

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha?: string | null;
  content?: string;
}

const BLOB_UPLOAD_CONCURRENCY = 5;

/** GitHub GET /git/ref on a repo with no commits: HTTP 409 Git Repository is empty. */
export function isEmptyGitHubRepositoryError(error: {
  statusCode?: number;
  message?: string;
}): boolean {
  return (
    error.statusCode === 409 &&
    /git repository is empty/i.test(error.message ?? "")
  );
}

export async function createGitBlobs(options: {
  owner: string;
  repo: string;
  pat: string;
  files: Record<string, string>;
  toPath: (name: string) => string;
  onBlobProgress?: (completed: number, total: number) => void;
}): Promise<ApiResult<GitTreeEntry[]>> {
  const entries = Object.entries(options.files);
  const total = entries.length;
  if (total === 0) {
    return { ok: true, data: [] };
  }

  const results: GitTreeEntry[] = new Array(total);
  let nextIndex = 0;
  let completed = 0;
  let firstError: ApiError | undefined;
  let abort = false;

  const worker = async (): Promise<void> => {
    while (true) {
      if (abort) {
        return;
      }
      const i = nextIndex++;
      if (i >= total) {
        return;
      }
      if (abort) {
        return;
      }
      const file = entries[i];
      if (!file) {
        return;
      }
      const [name, content] = file;
      const blobResult = await withRetry(() =>
        githubRequest<{ sha: string }>(
          "POST",
          `/repos/${options.owner}/${options.repo}/git/blobs`,
          options.pat,
          { content, encoding: "utf-8" }
        )
      );
      if (!blobResult.ok) {
        abort = true;
        firstError = blobResult.error;
        return;
      }
      results[i] = {
        path: options.toPath(name),
        mode: "100644",
        type: "blob",
        sha: blobResult.data.sha,
      };
      completed += 1;
      options.onBlobProgress?.(completed, total);
    }
  };

  const workerCount = Math.min(BLOB_UPLOAD_CONCURRENCY, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (firstError) {
    return { ok: false, error: firstError };
  }
  return { ok: true, data: results };
}

/**
 * Tree mutations that migrate leftover dashed files at `basePath` root.
 * Dashed-only files are retargeted to the nested path (reuse blob SHA).
 * When nested already exists, the name is being uploaded, or it is deleted,
 * only the dashed path is removed.
 */
export function leftoverDashedTreeEntries(
  leftovers: LeftoverDashedFile[],
  basePath: string,
  files: Record<string, string>,
  deleteNames: Set<string>
): GitTreeEntry[] {
  const items: GitTreeEntry[] = [];
  for (const leftover of leftovers) {
    const dashedPath = joinRemotePath(basePath, leftover.dashedRelative);
    const nestedPath = joinRemotePath(
      basePath,
      remoteNameToGitRelative(leftover.remoteName)
    );
    const uploading = Object.prototype.hasOwnProperty.call(
      files,
      leftover.remoteName
    );
    const deleting = deleteNames.has(leftover.remoteName);
    if (deleting || uploading || leftover.nestedPresent) {
      items.push({
        path: dashedPath,
        mode: "100644",
        type: "blob",
        sha: null,
      });
      continue;
    }
    items.push({
      path: nestedPath,
      mode: "100644",
      type: "blob",
      sha: leftover.blobSha,
    });
    items.push({
      path: dashedPath,
      mode: "100644",
      type: "blob",
      sha: null,
    });
  }
  return items;
}

export async function createInitialCommit(options: {
  owner: string;
  repo: string;
  pat: string;
  branch: string;
  basePath: string;
  identity: string;
  htmlUrl: string;
  files: Record<string, string>;
  deleteNames: Set<string>;
  onBlobProgress?: (completed: number, total: number) => void;
}): Promise<ApiResult<RemoteWriteResult>> {
  void options.deleteNames;
  const blobResult = await createGitBlobs({
    owner: options.owner,
    repo: options.repo,
    pat: options.pat,
    files: options.files,
    toPath: (name) => repoGitPath(options.basePath, name),
    onBlobProgress: options.onBlobProgress,
  });
  if (!blobResult.ok) {
    return blobResult;
  }
  const treeItems = blobResult.data;

  if (treeItems.length === 0) {
    return {
      ok: false,
      error: {
        category: "UNKNOWN",
        message: "Cannot create empty initial commit for repo sync.",
      },
    };
  }

  const treeResult = await withRetry(() =>
    githubRequest<{ sha: string }>(
      "POST",
      `/repos/${options.owner}/${options.repo}/git/trees`,
      options.pat,
      { tree: treeItems }
    )
  );
  if (!treeResult.ok) {
    return treeResult;
  }

  const commitResult = await withRetry(() =>
    githubRequest<{ sha: string }>(
      "POST",
      `/repos/${options.owner}/${options.repo}/git/commits`,
      options.pat,
      {
        message: commandTitle("initial settings backup"),
        tree: treeResult.data.sha,
        parents: [],
      }
    )
  );
  if (!commitResult.ok) {
    return commitResult;
  }

  const refCreate = await withRetry(() =>
    githubRequest<{ object: { sha: string; type: string }; ref: string; url: string }>(
      "POST",
      `/repos/${options.owner}/${options.repo}/git/refs`,
      options.pat,
      {
        ref: `refs/heads/${options.branch}`,
        sha: commitResult.data.sha,
      }
    )
  );
  if (!refCreate.ok) {
    return refCreate;
  }

  return {
    ok: true,
    data: {
      id: options.identity,
      htmlUrl: options.htmlUrl,
      created: true,
    },
  };
}
