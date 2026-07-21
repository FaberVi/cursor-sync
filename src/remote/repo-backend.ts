import type { ApiResult } from "../types.js";
import {
  DEFAULT_REPO_BASE_PATH,
  DEFAULT_REPO_BRANCH,
} from "./destination.js";
import { githubRequest } from "./github-api.js";
import { joinRemotePath, stripRemotePath } from "./path-map.js";
import type {
  RemoteDiscoverResult,
  RemoteSnapshot,
  RemoteSnapshotOptions,
  RemoteSyncBackend,
  RemoteWriteResult,
} from "./types.js";

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

interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha?: string | null;
  content?: string;
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

interface RepoResponse {
  full_name: string;
  html_url: string;
  default_branch: string;
}

export class RepoBackend implements RemoteSyncBackend {
  readonly type = "repo" as const;
  private pat: string;
  private owner: string;
  private repo: string;
  private branch: string;
  private basePath: string;

  constructor(options: {
    pat: string;
    owner: string;
    repo: string;
    branch?: string;
    basePath?: string;
  }) {
    this.pat = options.pat;
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch || DEFAULT_REPO_BRANCH;
    this.basePath = options.basePath || DEFAULT_REPO_BASE_PATH;
  }

  remoteLabel(): string {
    return `${this.owner}/${this.repo}@${this.branch}`;
  }

  remoteUrl(): string | undefined {
    return `https://github.com/${this.owner}/${this.repo}/tree/${this.branch}/${this.basePath}`;
  }

  getIdentity(): string {
    return `${this.owner}/${this.repo}`;
  }

  getOwner(): string {
    return this.owner;
  }

  getRepo(): string {
    return this.repo;
  }

  getBranch(): string {
    return this.branch;
  }

  getBasePath(): string {
    return this.basePath;
  }

  async validateAccess(): Promise<ApiResult<boolean>> {
    const result = await githubRequest<RepoResponse>(
      "GET",
      `/repos/${this.owner}/${this.repo}`,
      this.pat
    );
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: true };
  }

  async getAuthenticatedLogin(): Promise<ApiResult<string>> {
    const result = await githubRequest<{ login: string }>(
      "GET",
      "/user",
      this.pat
    );
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: result.data.login };
  }

  /**
   * Create the target repository via GitHub API.
   * User-owned repos use POST /user/repos; otherwise POST /orgs/{owner}/repos.
   */
  async createRepository(options?: {
    isPrivate?: boolean;
    description?: string;
    autoInit?: boolean;
  }): Promise<ApiResult<RepoResponse>> {
    const loginResult = await this.getAuthenticatedLogin();
    if (!loginResult.ok) {
      return loginResult;
    }

    const body = {
      name: this.repo,
      private: options?.isPrivate ?? true,
      description:
        options?.description ?? "Cursor Sync settings backup",
      auto_init: options?.autoInit ?? true,
    };

    const login = loginResult.data;
    if (login.toLowerCase() === this.owner.toLowerCase()) {
      return githubRequest<RepoResponse>("POST", "/user/repos", this.pat, body);
    }

    return githubRequest<RepoResponse>(
      "POST",
      `/orgs/${this.owner}/repos`,
      this.pat,
      body
    );
  }

  async discover(): Promise<ApiResult<RemoteDiscoverResult | null>> {
    const repoResult = await githubRequest<RepoResponse>(
      "GET",
      `/repos/${this.owner}/${this.repo}`,
      this.pat
    );
    if (!repoResult.ok) {
      return repoResult;
    }

    const refResult = await this.getBranchRef();
    if (!refResult.ok) {
      if (refResult.error.statusCode === 404) {
        return {
          ok: true,
          data: {
            id: this.getIdentity(),
            htmlUrl: repoResult.data.html_url,
          },
        };
      }
      return refResult;
    }

    return {
      ok: true,
      data: {
        id: this.getIdentity(),
        htmlUrl: this.remoteUrl()!,
      },
    };
  }

  async getSnapshot(
    options?: RemoteSnapshotOptions
  ): Promise<ApiResult<RemoteSnapshot>> {
    const refResult = await this.getBranchRef();
    if (!refResult.ok) {
      if (refResult.error.statusCode === 404) {
        return {
          ok: true,
          data: {
            id: this.getIdentity(),
            htmlUrl: this.remoteUrl()!,
            files: {},
            allFileNames: [],
          },
        };
      }
      return refResult;
    }

    const commitResult = await githubRequest<GitCommitResponse>(
      "GET",
      `/repos/${this.owner}/${this.repo}/git/commits/${refResult.data.object.sha}`,
      this.pat
    );
    if (!commitResult.ok) {
      return commitResult;
    }

    const treeResult = await githubRequest<GitTreeResponse>(
      "GET",
      `/repos/${this.owner}/${this.repo}/git/trees/${commitResult.data.tree.sha}?recursive=1`,
      this.pat
    );
    if (!treeResult.ok) {
      return treeResult;
    }

    const blobsByName = new Map<string, string>();
    for (const entry of treeResult.data.tree) {
      if (entry.type !== "blob") {
        continue;
      }
      const flatName = stripRemotePath(this.basePath, entry.path);
      if (!flatName || flatName.includes("/")) {
        continue;
      }
      blobsByName.set(flatName, entry.sha);
    }

    const allFileNames = [...blobsByName.keys()];
    const only = options?.onlyFiles;
    const namesToFetch =
      only && only.length > 0
        ? only.filter((name) => blobsByName.has(name))
        : allFileNames;

    const files: Record<string, string> = {};
    for (const flatName of namesToFetch) {
      const sha = blobsByName.get(flatName);
      if (!sha) {
        continue;
      }
      const blobResult = await githubRequest<GitBlobResponse>(
        "GET",
        `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`,
        this.pat
      );
      if (!blobResult.ok) {
        return blobResult;
      }
      files[flatName] = decodeBlobContent(
        blobResult.data.content,
        blobResult.data.encoding
      );
    }

    return {
      ok: true,
      data: {
        id: this.getIdentity(),
        htmlUrl: this.remoteUrl()!,
        files,
        allFileNames,
      },
    };
  }

  async writeFiles(
    files: Record<string, string>,
    options?: { deleteNames?: string[] }
  ): Promise<ApiResult<RemoteWriteResult>> {
    const deleteNames = new Set(options?.deleteNames ?? []);
    const refResult = await this.getBranchRef();

    let parentCommitSha: string | undefined;
    let baseTreeSha: string | undefined;
    let createdBranch = false;

    if (!refResult.ok) {
      if (refResult.error.statusCode !== 404) {
        return refResult;
      }
      createdBranch = true;
      const init = await this.createInitialCommit(files, deleteNames);
      return init;
    }

    parentCommitSha = refResult.data.object.sha;
    const commitResult = await githubRequest<GitCommitResponse>(
      "GET",
      `/repos/${this.owner}/${this.repo}/git/commits/${parentCommitSha}`,
      this.pat
    );
    if (!commitResult.ok) {
      return commitResult;
    }
    baseTreeSha = commitResult.data.tree.sha;

    const treeItems: GitTreeEntry[] = [];
    for (const [name, content] of Object.entries(files)) {
      const blobResult = await githubRequest<{ sha: string }>(
        "POST",
        `/repos/${this.owner}/${this.repo}/git/blobs`,
        this.pat,
        { content, encoding: "utf-8" }
      );
      if (!blobResult.ok) {
        return blobResult;
      }
      treeItems.push({
        path: joinRemotePath(this.basePath, name),
        mode: "100644",
        type: "blob",
        sha: blobResult.data.sha,
      });
    }

    for (const name of deleteNames) {
      if (name in files) {
        continue;
      }
      treeItems.push({
        path: joinRemotePath(this.basePath, name),
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    if (treeItems.length === 0) {
      return {
        ok: true,
        data: {
          id: this.getIdentity(),
          htmlUrl: this.remoteUrl()!,
          created: false,
        },
      };
    }

    const treeResult = await githubRequest<{ sha: string }>(
      "POST",
      `/repos/${this.owner}/${this.repo}/git/trees`,
      this.pat,
      {
        base_tree: baseTreeSha,
        tree: treeItems,
      }
    );
    if (!treeResult.ok) {
      return treeResult;
    }

    const newCommit = await githubRequest<{ sha: string }>(
      "POST",
      `/repos/${this.owner}/${this.repo}/git/commits`,
      this.pat,
      {
        message: "Cursor Sync: update settings backup",
        tree: treeResult.data.sha,
        parents: [parentCommitSha],
      }
    );
    if (!newCommit.ok) {
      return newCommit;
    }

    const updateRef = await githubRequest<GitRefResponse>(
      "PATCH",
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.branch}`,
      this.pat,
      { sha: newCommit.data.sha }
    );
    if (!updateRef.ok) {
      return updateRef;
    }

    return {
      ok: true,
      data: {
        id: this.getIdentity(),
        htmlUrl: this.remoteUrl()!,
        created: createdBranch,
      },
    };
  }

  private async getBranchRef(): Promise<ApiResult<GitRefResponse>> {
    return githubRequest<GitRefResponse>(
      "GET",
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${this.branch}`,
      this.pat
    );
  }

  private async createInitialCommit(
    files: Record<string, string>,
    deleteNames: Set<string>
  ): Promise<ApiResult<RemoteWriteResult>> {
    void deleteNames;
    const treeItems: GitTreeEntry[] = [];
    for (const [name, content] of Object.entries(files)) {
      const blobResult = await githubRequest<{ sha: string }>(
        "POST",
        `/repos/${this.owner}/${this.repo}/git/blobs`,
        this.pat,
        { content, encoding: "utf-8" }
      );
      if (!blobResult.ok) {
        return blobResult;
      }
      treeItems.push({
        path: joinRemotePath(this.basePath, name),
        mode: "100644",
        type: "blob",
        sha: blobResult.data.sha,
      });
    }

    if (treeItems.length === 0) {
      return {
        ok: false,
        error: {
          category: "UNKNOWN",
          message: "Cannot create empty initial commit for repo sync.",
        },
      };
    }

    const treeResult = await githubRequest<{ sha: string }>(
      "POST",
      `/repos/${this.owner}/${this.repo}/git/trees`,
      this.pat,
      { tree: treeItems }
    );
    if (!treeResult.ok) {
      return treeResult;
    }

    const commitResult = await githubRequest<{ sha: string }>(
      "POST",
      `/repos/${this.owner}/${this.repo}/git/commits`,
      this.pat,
      {
        message: "Cursor Sync: initial settings backup",
        tree: treeResult.data.sha,
        parents: [],
      }
    );
    if (!commitResult.ok) {
      return commitResult;
    }

    const refCreate = await githubRequest<GitRefResponse>(
      "POST",
      `/repos/${this.owner}/${this.repo}/git/refs`,
      this.pat,
      {
        ref: `refs/heads/${this.branch}`,
        sha: commitResult.data.sha,
      }
    );
    if (!refCreate.ok) {
      return refCreate;
    }

    return {
      ok: true,
      data: {
        id: this.getIdentity(),
        htmlUrl: this.remoteUrl()!,
        created: true,
      },
    };
  }
}

function decodeBlobContent(content: string, encoding: string): string {
  if (encoding === "base64") {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf-8");
  }
  return content;
}
