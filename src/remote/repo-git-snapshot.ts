import { githubRequest } from "./github-api.js";
import {
  gitRelativeToRemoteName,
  isLegacyDashedRelative,
  stripRemotePath,
  type LeftoverDashedFile,
} from "./path-map.js";
import { isEmptyGitHubRepositoryError } from "./repo-git-write.js";
import { withRetry } from "../retry.js";
import { getLogger } from "../diagnostics.js";
import type { ApiError, ApiResult } from "../types.js";
import type { RemoteSnapshot, RemoteSnapshotOptions } from "./types.js";

const BLOB_DOWNLOAD_CONCURRENCY = 5;

interface GitRefResponse {
  object: { sha: string; type: string };
  ref: string;
  url: string;
}

interface GitCommitResponse {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
}

interface GitTreeResponse {
  sha: string;
  tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
  truncated: boolean;
}

interface GitBlobResponse {
  content: string;
  encoding: string;
  sha: string;
  size: number;
}

export type RepoGitSnapshotCache = {
  refShaCache: string | undefined;
  treeCache:
    | {
        refSha: string;
        blobsByName: Map<string, string>;
        leftoverDashed: LeftoverDashedFile[];
      }
    | undefined;
};

export async function loadRepoGitSnapshot(params: {
  owner: string;
  repo: string;
  pat: string;
  basePath: string;
  identity: string;
  htmlUrl: string;
  cache: RepoGitSnapshotCache;
  getBranchRef: () => Promise<ApiResult<GitRefResponse>>;
  options?: RemoteSnapshotOptions;
}): Promise<ApiResult<RemoteSnapshot>> {
  const { owner, repo, pat, basePath, identity, htmlUrl, cache, options } = params;
  let refSha = cache.refShaCache;
  if (!refSha) {
    const refResult = await params.getBranchRef();
    if (!refResult.ok) {
      if (
        refResult.error.statusCode === 404 ||
        isEmptyGitHubRepositoryError(refResult.error)
      ) {
        return {
          ok: true,
          data: {
            id: identity,
            htmlUrl,
            files: {},
            allFileNames: [],
          },
        };
      }
      return refResult;
    }
    refSha = refResult.data.object.sha;
    cache.refShaCache = refSha;
  }
  let blobsByName =
    cache.treeCache?.refSha === refSha ? cache.treeCache.blobsByName : undefined;

  if (!blobsByName) {
    const commitResult = await githubRequest<GitCommitResponse>(
      "GET",
      `/repos/${owner}/${repo}/git/commits/${refSha}`,
      pat
    );
    if (!commitResult.ok) {
      return commitResult;
    }

    const treeResult = await githubRequest<GitTreeResponse>(
      "GET",
      `/repos/${owner}/${repo}/git/trees/${commitResult.data.tree.sha}?recursive=1`,
      pat
    );
    if (!treeResult.ok) {
      return treeResult;
    }

    const nestedSha = new Map<string, string>();
    const dashedSha = new Map<string, string>();
    const rootSha = new Map<string, string>();
    const dashedMeta = new Map<
      string,
      { dashedRelative: string; blobSha: string; remoteName: string }
    >();

    for (const entry of treeResult.data.tree) {
      if (entry.type !== "blob") {
        continue;
      }
      const relative = stripRemotePath(basePath, entry.path);
      if (!relative) {
        continue;
      }
      const remoteName = gitRelativeToRemoteName(relative);
      if (relative.includes("/")) {
        nestedSha.set(remoteName, entry.sha);
      } else if (isLegacyDashedRelative(relative)) {
        dashedSha.set(remoteName, entry.sha);
        dashedMeta.set(remoteName, {
          dashedRelative: relative,
          blobSha: entry.sha,
          remoteName,
        });
      } else {
        rootSha.set(remoteName, entry.sha);
      }
    }

    blobsByName = new Map<string, string>();
    for (const [name, sha] of nestedSha) {
      blobsByName.set(name, sha);
    }
    for (const [name, sha] of rootSha) {
      if (!blobsByName.has(name)) {
        blobsByName.set(name, sha);
      }
    }
    for (const [name, sha] of dashedSha) {
      if (!blobsByName.has(name)) {
        blobsByName.set(name, sha);
      }
    }

    const leftoverDashed: LeftoverDashedFile[] = [];
    for (const meta of dashedMeta.values()) {
      leftoverDashed.push({
        ...meta,
        nestedPresent: nestedSha.has(meta.remoteName),
      });
    }

    cache.treeCache = { refSha, blobsByName, leftoverDashed };
  }

  const allFileNames = [...blobsByName.keys()];
  const only = options?.onlyFiles;
  const namesToFetch =
    only && only.length > 0
      ? only.filter((name) => blobsByName.has(name))
      : allFileNames;

  const files: Record<string, string> = {};
  const total = namesToFetch.length;
  let completed = 0;

  if (total > 0) {
    getLogger().appendLine(
      `[Cursor Sync] Downloading ${total} file(s) from repo (concurrency ${BLOB_DOWNLOAD_CONCURRENCY}).`
    );
  }

  let nextIndex = 0;
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
      const flatName = namesToFetch[i];
      if (!flatName) {
        return;
      }
      const sha = blobsByName.get(flatName);
      if (!sha) {
        continue;
      }
      const blobResult = await withRetry(() =>
        githubRequest<GitBlobResponse>(
          "GET",
          `/repos/${owner}/${repo}/git/blobs/${sha}`,
          pat
        )
      );
      if (!blobResult.ok) {
        abort = true;
        firstError = blobResult.error;
        return;
      }
      files[flatName] = decodeBlobContent(
        blobResult.data.content,
        blobResult.data.encoding
      );
      completed += 1;
      options?.onFileProgress?.(completed, total);
    }
  };

  if (total > 0) {
    const workerCount = Math.min(BLOB_DOWNLOAD_CONCURRENCY, total);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  if (firstError) {
    return { ok: false, error: firstError };
  }

  return {
    ok: true,
    data: {
      id: identity,
      htmlUrl,
      files,
      allFileNames,
    },
  };
}

function decodeBlobContent(content: string, encoding: string): string {
  if (encoding === "base64") {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf-8");
  }
  return content;
}
