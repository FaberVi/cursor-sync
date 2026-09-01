import { githubRequest } from "./github-api.js";
import { stripRemotePath } from "./path-map.js";
import type { ApiResult } from "../types.js";
import type { RemoteSnapshot, RemoteSnapshotOptions } from "./types.js";

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
    | { refSha: string; blobsByName: Map<string, string> }
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
      if (refResult.error.statusCode === 404) {
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
  let blobsByName = cache.treeCache?.refSha === refSha ? cache.treeCache.blobsByName : undefined;

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

    blobsByName = new Map<string, string>();
    for (const entry of treeResult.data.tree) {
      if (entry.type !== "blob") {
        continue;
      }
      const flatName = stripRemotePath(basePath, entry.path);
      if (!flatName || flatName.includes("/")) {
        continue;
      }
      blobsByName.set(flatName, entry.sha);
    }
    cache.treeCache = { refSha, blobsByName };
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
  for (const flatName of namesToFetch) {
    const sha = blobsByName.get(flatName);
    if (!sha) {
      continue;
    }
    const blobResult = await githubRequest<GitBlobResponse>(
      "GET",
      `/repos/${owner}/${repo}/git/blobs/${sha}`,
      pat
    );
    if (!blobResult.ok) {
      return blobResult;
    }
    files[flatName] = decodeBlobContent(
      blobResult.data.content,
      blobResult.data.encoding
    );
    completed += 1;
    options?.onFileProgress?.(completed, total);
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
