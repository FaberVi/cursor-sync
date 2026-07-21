import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  applyRepoSettingsToSyncState,
  hasRemoteDestination,
  normalizeBasePath,
  normalizeSyncStateDestination,
  parseOwnerRepo,
  remoteSnapshotFileNames,
  DEFAULT_REPO_BASE_PATH,
} from "../src/remote/index.js";
import { joinRemotePath, stripRemotePath } from "../src/remote/path-map.js";
import type { SyncState } from "../src/types.js";
import {
  MIN_INTERVAL_SECONDS,
  resolveScheduleInterval,
} from "../src/schedule-interval.js";
import { RepoBackend } from "../src/remote/repo-backend.js";
describe("parseOwnerRepo", () => {
  it("parses owner/name", () => {
    expect(parseOwnerRepo("acme/cursor-backup")).toEqual({
      owner: "acme",
      repo: "cursor-backup",
    });
  });

  it("parses github URL", () => {
    expect(parseOwnerRepo("https://github.com/acme/cursor-backup.git")).toEqual({
      owner: "acme",
      repo: "cursor-backup",
    });
  });

  it("rejects invalid", () => {
    expect(parseOwnerRepo("only-one")).toBeUndefined();
  });
});

describe("path-map", () => {
  it("joins and strips base path", () => {
    expect(joinRemotePath("cursor-sync", "manifest.json")).toBe("cursor-sync/manifest.json");
    expect(stripRemotePath("cursor-sync", "cursor-sync/manifest.json")).toBe("manifest.json");
    expect(stripRemotePath("cursor-sync", "other/file.json")).toBeUndefined();
  });
});

describe("applyRepoSettingsToSyncState", () => {
  it("replaces saved basePath with current settings path", () => {
    const state: SyncState = {
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "",
      destination: {
        type: "repo",
        owner: "acme",
        repo: "backup",
        branch: "main",
        basePath: "old-path",
      },
      localChecksums: { a: "1" },
      remoteChecksums: { a: "1" },
    };
    const next = applyRepoSettingsToSyncState(state, {
      type: "repo",
      repo: "acme/backup",
      branch: "main",
      path: "new-path",
    });
    expect(next?.destination).toEqual({
      type: "repo",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "new-path",
      gistId: undefined,
    });
    expect(next?.localChecksums).toEqual({ a: "1" });
  });

  it("returns undefined when there is no sync state yet", () => {
    expect(
      applyRepoSettingsToSyncState(undefined, {
        type: "repo",
        repo: "acme/backup",
        branch: "main",
        path: "cursor-sync",
      })
    ).toBeUndefined();
  });
});

describe("normalizeBasePath", () => {
  it("strips slashes and falls back to default", () => {
    expect(normalizeBasePath(" /foo/bar/ ")).toBe("foo/bar");
    expect(normalizeBasePath("")).toBe(DEFAULT_REPO_BASE_PATH);
  });
});

describe("resolveScheduleInterval", () => {
  it("clamps seconds below minimum", () => {
    const resolved = resolveScheduleInterval({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.interval") return 5;
        if (key === "schedule.intervalUnit") return "seconds";
        return undefined;
      },
      inspect: (key: string) =>
        key === "schedule.interval" ? { globalValue: 5 } : undefined,
    } as never);
    expect(resolved.intervalSeconds).toBe(MIN_INTERVAL_SECONDS);
  });

  it("uses minutes unit", () => {
    const resolved = resolveScheduleInterval({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.interval") return 10;
        if (key === "schedule.intervalUnit") return "minutes";
        return undefined;
      },
      inspect: (key: string) =>
        key === "schedule.interval" ? { globalValue: 10 } : undefined,
    } as never);
    expect(resolved.intervalSeconds).toBe(600);
    expect(resolved.intervalMs).toBe(600_000);
  });

  it("falls back to deprecated intervalMin", () => {
    const resolved = resolveScheduleInterval({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.intervalMin") return 15;
        if (key === "schedule.intervalUnit") return "seconds";
        return undefined;
      },
      inspect: () => undefined,
    } as never);
    expect(resolved.unit).toBe("minutes");
    expect(resolved.intervalSeconds).toBe(15 * 60);
  });
});

describe("RepoBackend", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("writes files via Git Data API", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });

      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(JSON.stringify({ object: { sha: "commit1", type: "commit" }, ref: "refs/heads/main", url }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/commits/commit1") && method === "GET") {
        return new Response(JSON.stringify({ sha: "commit1", tree: { sha: "tree1" }, parents: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/blobs") && method === "POST") {
        return new Response(JSON.stringify({ sha: "blob1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/trees") && method === "POST") {
        return new Response(JSON.stringify({ sha: "tree2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/commits") && method === "POST") {
        return new Response(JSON.stringify({ sha: "commit2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/refs/heads/main") && method === "PATCH") {
        return new Response(JSON.stringify({ object: { sha: "commit2", type: "commit" }, ref: "refs/heads/main", url }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "unexpected " + method + " " + url }), { status: 500 });
    }) as typeof fetch;

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });

    const result = await backend.writeFiles({
      "manifest.json": "{\"schemaVersion\":1}",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("acme/backup");
    }
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/git/blobs"))).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/git/refs/heads/main"))).toBe(true);
  });

  it("getSnapshot returns empty files when branch missing", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response("{}", { status: 500 });
    }) as typeof fetch;

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const snap = await backend.getSnapshot();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.data.files).toEqual({});
      expect(snap.data.allFileNames).toEqual([]);
      expect(remoteSnapshotFileNames(snap.data)).toEqual([]);
    }
  });

  it("remoteSnapshotFileNames falls back to Object.keys(files)", () => {
    expect(
      remoteSnapshotFileNames({
        id: "x",
        htmlUrl: "https://example.com",
        files: { "manifest.json": "{}" },
      })
    ).toEqual(["manifest.json"]);
  });

  it("creates a user-owned repository when missing", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });

      if (url.endsWith("/user") && method === "GET") {
        return new Response(JSON.stringify({ login: "acme" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/user/repos") && method === "POST") {
        return new Response(
          JSON.stringify({
            full_name: "acme/backup",
            html_url: "https://github.com/acme/backup",
            default_branch: "main",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    }) as typeof fetch;

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const created = await backend.createRepository({ isPrivate: true });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.data.full_name).toBe("acme/backup");
    }
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/user/repos"));
    expect(post?.body).toMatchObject({
      name: "backup",
      private: true,
      auto_init: true,
    });
  });

  it("creates an org repository when owner differs from login", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/user") && method === "GET") {
        return new Response(JSON.stringify({ login: "alice" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/orgs/acme/repos") && method === "POST") {
        return new Response(
          JSON.stringify({
            full_name: "acme/backup",
            html_url: "https://github.com/acme/backup",
            default_branch: "main",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    }) as typeof fetch;

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const created = await backend.createRepository({ isPrivate: false });
    expect(created.ok).toBe(true);
  });
});
