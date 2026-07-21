import { GistClient, fetchGistFileContent } from "../gist.js";
import type { ApiResult } from "../types.js";
import type {
  RemoteDiscoverResult,
  RemoteSnapshot,
  RemoteSnapshotOptions,
  RemoteSyncBackend,
  RemoteWriteResult,
} from "./types.js";

const SETTINGS_GIST_DESCRIPTION = "Cursor Sync - Settings Backup";

export class GistBackend implements RemoteSyncBackend {
  readonly type = "gist" as const;
  private client: GistClient;
  private pat: string;
  private gistId: string | undefined;
  private lastHtmlUrl: string | undefined;

  constructor(pat: string, gistId?: string) {
    this.pat = pat;
    this.client = new GistClient(pat);
    this.gistId = gistId;
  }

  remoteLabel(): string {
    return this.gistId ? `Gist ${this.gistId.slice(0, 8)}…` : "Gist (new)";
  }

  remoteUrl(): string | undefined {
    if (this.lastHtmlUrl) {
      return this.lastHtmlUrl;
    }
    return this.gistId ? `https://gist.github.com/${this.gistId}` : undefined;
  }

  getGistId(): string | undefined {
    return this.gistId;
  }

  async discover(): Promise<ApiResult<RemoteDiscoverResult | null>> {
    if (this.gistId) {
      const result = await this.client.getGist(this.gistId);
      if (!result.ok) {
        return result;
      }
      this.lastHtmlUrl = result.data.html_url;
      return {
        ok: true,
        data: { id: result.data.id, htmlUrl: result.data.html_url },
      };
    }
    const found = await this.client.findExistingGist();
    if (!found.ok) {
      return found;
    }
    if (!found.data) {
      return { ok: true, data: null };
    }
    this.gistId = found.data.id;
    this.lastHtmlUrl = found.data.html_url;
    return {
      ok: true,
      data: { id: found.data.id, htmlUrl: found.data.html_url },
    };
  }

  async getSnapshot(
    options?: RemoteSnapshotOptions
  ): Promise<ApiResult<RemoteSnapshot>> {
    if (!this.gistId) {
      const discovered = await this.discover();
      if (!discovered.ok) {
        return discovered;
      }
      if (!discovered.data) {
        return {
          ok: true,
          data: {
            id: "",
            htmlUrl: "",
            files: {},
            allFileNames: [],
          },
        };
      }
    }

    const result = await this.client.getGist(this.gistId!);
    if (!result.ok) {
      return result;
    }

    this.lastHtmlUrl = result.data.html_url;
    const allFileNames = Object.keys(result.data.files);
    const only = options?.onlyFiles;
    const namesToFetch =
      only && only.length > 0
        ? only.filter((name) => Object.prototype.hasOwnProperty.call(result.data.files, name))
        : allFileNames;
    const files: Record<string, string> = {};

    for (const name of namesToFetch) {
      const file = result.data.files[name];
      try {
        files[name] = await fetchGistFileContent(file, this.pat);
      } catch (err) {
        return {
          ok: false,
          error: {
            category: "UNKNOWN",
            message:
              err instanceof Error
                ? err.message
                : `Failed to read gist file ${name}`,
          },
        };
      }
    }

    return {
      ok: true,
      data: {
        id: result.data.id,
        htmlUrl: result.data.html_url,
        files,
        allFileNames,
      },
    };
  }

  async writeFiles(
    files: Record<string, string>,
    options?: { deleteNames?: string[] }
  ): Promise<ApiResult<RemoteWriteResult>> {
    const payload: Record<string, { content: string } | null> = {};
    for (const [name, content] of Object.entries(files)) {
      payload[name] = { content };
    }
    for (const name of options?.deleteNames ?? []) {
      if (!(name in payload)) {
        payload[name] = null;
      }
    }

    if (!this.gistId) {
      const existing = await this.client.findExistingGist();
      if (existing.ok && existing.data) {
        this.gistId = existing.data.id;
      }
    }

    if (!this.gistId) {
      const createPayload: Record<string, { content: string }> = {};
      for (const [name, content] of Object.entries(files)) {
        createPayload[name] = { content };
      }
      const created = await this.client.createGist(
        createPayload,
        SETTINGS_GIST_DESCRIPTION
      );
      if (!created.ok) {
        return created;
      }
      this.gistId = created.data.id;
      this.lastHtmlUrl = created.data.html_url;
      return {
        ok: true,
        data: {
          id: created.data.id,
          htmlUrl: created.data.html_url,
          created: true,
        },
      };
    }

    const updated = await this.client.updateGist(this.gistId, payload);
    if (!updated.ok) {
      return updated;
    }
    this.lastHtmlUrl = updated.data.html_url;
    return {
      ok: true,
      data: {
        id: updated.data.id,
        htmlUrl: updated.data.html_url,
        created: false,
      },
    };
  }
}
