import {
  DEFAULT_REPO_BASE_PATH,
  DEFAULT_REPO_BRANCH,
} from "./destination.js";
import { commandTitle, REPO_SETTINGS_BACKUP_DESCRIPTION } from "../extension-branding.js";
import { githubRequest } from "./github-api.js";
import { repoGitPath, type LeftoverDashedFile } from "./path-map.js";
import { withRetry } from "../retry.js";
import type { ApiResult } from "../types.js";
import type {
  RemoteDiscoverResult,
  RemoteSnapshot,
  RemoteSnapshotOptions,
  RemoteSyncBackend,
  RemoteWriteOptions,
  RemoteWriteResult,
} from "./types.js";
import {
  createGitBlobs,
  createInitialCommit,
  isEmptyGitHubRepositoryError,
  leftoverDashedTreeEntries,
  type GitTreeEntry,
} from "./repo-git-write.js";
import { loadRepoGitSnapshot, type RepoGitSnapshotCache } from "./repo-git-snapshot.js";

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
  /** Ref + tree blobs for this instance (invalidated on write). */
  private gitCache: RepoGitSnapshotCache = {
    refShaCache: undefined,
    treeCache: undefined,
  };
  /** Leftover dashed Git files from the last successful snapshot. */
  private leftoverDashed: LeftoverDashedFile[] = [];

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

  hasLeftoverDashed(): boolean {
    return this.leftoverDashed.length > 0;
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
        options?.description ?? REPO_SETTINGS_BACKUP_DESCRIPTION,
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
      if (
        refResult.error.statusCode === 404 ||
        isEmptyGitHubRepositoryError(refResult.error)
      ) {
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
    const result = await loadRepoGitSnapshot({
      owner: this.owner,
      repo: this.repo,
      pat: this.pat,
      basePath: this.basePath,
      identity: this.getIdentity(),
      htmlUrl: this.remoteUrl()!,
      cache: this.gitCache,
      getBranchRef: () => this.getBranchRef(),
      options,
    });
    if (result.ok) {
      this.leftoverDashed = this.gitCache.treeCache?.leftoverDashed ?? [];
    }
    return result;
  }

  async writeFiles(
    files: Record<string, string>,
    options?: RemoteWriteOptions
  ): Promise<ApiResult<RemoteWriteResult>> {
    const leftovers = [...this.leftoverDashed];
    this.gitCache.treeCache = undefined;
    this.gitCache.refShaCache = undefined;
    const deleteNames = new Set(options?.deleteNames ?? []);
    const refResult = await this.getBranchRef();

    let parentCommitSha: string | undefined;
    let baseTreeSha: string | undefined;
    let createdBranch = false;

    if (!refResult.ok) {
      if (
        refResult.error.statusCode !== 404 &&
        !isEmptyGitHubRepositoryError(refResult.error)
      ) {
        return refResult;
      }
      createdBranch = true;
      const initial = await createInitialCommit({
        owner: this.owner,
        repo: this.repo,
        pat: this.pat,
        branch: this.branch,
        basePath: this.basePath,
        identity: this.getIdentity(),
        htmlUrl: this.remoteUrl()!,
        files,
        deleteNames,
        onBlobProgress: options?.onBlobProgress,
      });
      if (initial.ok) {
        this.leftoverDashed = [];
      }
      return initial;
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

    const blobResult = await createGitBlobs({
      owner: this.owner,
      repo: this.repo,
      pat: this.pat,
      files,
      toPath: (name) => repoGitPath(this.basePath, name),
      onBlobProgress: options?.onBlobProgress,
    });
    if (!blobResult.ok) {
      return blobResult;
    }
    const treeItems: GitTreeEntry[] = [...blobResult.data];
    const leftoverByName = new Map(
      leftovers.map((item) => [item.remoteName, item])
    );

    for (const name of deleteNames) {
      if (name in files) {
        continue;
      }
      const leftover = leftoverByName.get(name);
      if (leftover && !leftover.nestedPresent) {
        continue;
      }
      treeItems.push({
        path: repoGitPath(this.basePath, name),
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    treeItems.push(
      ...leftoverDashedTreeEntries(leftovers, this.basePath, files, deleteNames)
    );

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

    const nestOnly =
      blobResult.data.length === 0 &&
      deleteNames.size === 0 &&
      leftovers.length > 0;

    const treeResult = await withRetry(() =>
      githubRequest<{ sha: string }>(
        "POST",
        `/repos/${this.owner}/${this.repo}/git/trees`,
        this.pat,
        {
          base_tree: baseTreeSha,
          tree: treeItems,
        }
      )
    );
    if (!treeResult.ok) {
      return treeResult;
    }

    const newCommit = await withRetry(() =>
      githubRequest<{ sha: string }>(
        "POST",
        `/repos/${this.owner}/${this.repo}/git/commits`,
        this.pat,
        {
          message: nestOnly
            ? commandTitle("nest repo backup paths")
            : commandTitle("update settings backup"),
          tree: treeResult.data.sha,
          parents: [parentCommitSha],
        }
      )
    );
    if (!newCommit.ok) {
      return newCommit;
    }

    const updateRef = await withRetry(() =>
      githubRequest<GitRefResponse>(
        "PATCH",
        `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.branch}`,
        this.pat,
        { sha: newCommit.data.sha }
      )
    );
    if (!updateRef.ok) {
      return updateRef;
    }

    this.leftoverDashed = [];
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
}
