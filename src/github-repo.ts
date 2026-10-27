import { REPO_SETTINGS_BACKUP_DESCRIPTION } from "./extension-branding.js";
import { githubRequest } from "./remote/github-api.js";
import type { ApiResult } from "./types.js";

interface RepoResponse {
  full_name: string;
  html_url: string;
  default_branch: string;
}

export class GitHubRepoClient {
  constructor(
    private pat: string,
    private owner: string,
    private repo: string
  ) {}

  getIdentity(): string {
    return `${this.owner}/${this.repo}`;
  }

  getOwner(): string {
    return this.owner;
  }

  getRepo(): string {
    return this.repo;
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
    const result = await githubRequest<{ login: string }>("GET", "/user", this.pat);
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: result.data.login };
  }

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
      description: options?.description ?? REPO_SETTINGS_BACKUP_DESCRIPTION,
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
}

export function githubCommitIdentity(login: string): { name: string; email: string } {
  return {
    name: login,
    email: `${login}@users.noreply.github.com`,
  };
}
