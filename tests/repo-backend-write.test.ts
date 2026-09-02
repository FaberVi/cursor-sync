import { mockFetch, restoreRemoteFetchAfterEach } from "./remote-backend-harness.js";
import { describe, it, expect, vi } from "vitest";
import { RepoBackend } from "../src/remote/repo-backend.js";

describe("RepoBackend write", () => {
  restoreRemoteFetchAfterEach();

  it("writes files via Git Data API", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    });

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
  it("creates a user-owned repository when missing", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    });

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

  it("creates an initial commit when the repository has no commits (HTTP 409)", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const treeBodies: unknown[] = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({ message: "Git Repository is empty." }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        return new Response(JSON.stringify({ sha: "blob1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/trees") && method === "POST") {
        treeBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify({ sha: "tree1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/commits") && method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body.parents).toEqual([]);
        expect(body.message).toContain("initial");
        return new Response(JSON.stringify({ sha: "commit1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/refs") && method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body.ref).toBe("refs/heads/main");
        expect(body.sha).toBe("commit1");
        return new Response(
          JSON.stringify({
            object: { sha: "commit1", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected " + method + " " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "empty",
      branch: "main",
      basePath: "cursor-sync",
    });
    const result = await backend.writeFiles({
      "manifest.json": "{\"schemaVersion\":1}",
      "cursor-user--settings.json": "{}",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(true);
      expect(result.data.id).toBe("acme/empty");
    }
    const tree = treeBodies[0] as { tree: Array<{ path: string }> };
    expect(tree.tree.map((entry) => entry.path).sort()).toEqual([
      "cursor-sync/cursor-user/settings.json",
      "cursor-sync/manifest.json",
    ]);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/git/refs"))).toBe(
      true
    );
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("does not treat a generic 409 as an empty repository", async () => {
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      const method = "GET";
      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(JSON.stringify({ message: "Update is not a fast forward" }), {
          status: 409,
        });
      }
      return new Response("{}", { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
    });
    const result = await backend.writeFiles({ "manifest.json": "{}" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(409);
      expect(result.error.message).toMatch(/fast forward/i);
    }
  });

  it("creates an org repository when owner differs from login", async () => {
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const created = await backend.createRepository({ isPrivate: false });
    expect(created.ok).toBe(true);
  });
  it("uploads blobs with concurrency 5 and reports progress", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const progress: Array<[number, number]> = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({
            object: { sha: "commit1", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/commit1") && method === "GET") {
        return new Response(
          JSON.stringify({ sha: "commit1", tree: { sha: "tree1" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inflight -= 1;
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
        return new Response(
          JSON.stringify({
            object: { sha: "commit2", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) {
      files[`file-${i}.json`] = `{"i":${i}}`;
    }
    const result = await backend.writeFiles(files, {
      onBlobProgress: (completed, total) => {
        progress.push([completed, total]);
      },
    });
    expect(result.ok).toBe(true);
    expect(maxInflight).toBe(5);
    expect(progress.at(-1)).toEqual([6, 6]);
    expect(progress).toHaveLength(6);
  });

  it("retries a single blob without posting a tree until blobs succeed", async () => {
    vi.useFakeTimers();
    let blobPosts = 0;
    let treePosts = 0;
    let failedOnce = false;
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({
            object: { sha: "commit1", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/commit1") && method === "GET") {
        return new Response(
          JSON.stringify({ sha: "commit1", tree: { sha: "tree1" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        blobPosts += 1;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.content === "retry-me" && !failedOnce) {
          failedOnce = true;
          return new Response(JSON.stringify({ message: "server" }), { status: 500 });
        }
        return new Response(JSON.stringify({ sha: "blob1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/trees") && method === "POST") {
        treePosts += 1;
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
        return new Response(
          JSON.stringify({
            object: { sha: "commit2", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
    });
    const pending = backend.writeFiles({
      "a.json": "retry-me",
      "b.json": "ok",
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();
    expect(result.ok).toBe(true);
    expect(blobPosts).toBe(3);
    expect(treePosts).toBe(1);
  });

  it("does not create a tree after a non-retryable blob error", async () => {
    let treePosts = 0;
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({
            object: { sha: "commit1", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/commit1") && method === "GET") {
        return new Response(
          JSON.stringify({ sha: "commit1", tree: { sha: "tree1" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        return new Response(JSON.stringify({ message: "bad credentials" }), {
          status: 401,
        });
      }
      if (url.includes("/git/trees") && method === "POST") {
        treePosts += 1;
        return new Response(JSON.stringify({ sha: "tree2" }), { status: 201 });
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
    });
    const result = await backend.writeFiles({
      "a.json": "1",
      "b.json": "2",
    });
    expect(result.ok).toBe(false);
    expect(treePosts).toBe(0);
  });

  it("writes gist-flat names as nested Git paths", async () => {
    const treeBodies: unknown[] = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({
            object: { sha: "commit1", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/commit1") && method === "GET") {
        return new Response(
          JSON.stringify({ sha: "commit1", tree: { sha: "tree1" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        return new Response(JSON.stringify({ sha: "blob1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/trees") && method === "POST") {
        treeBodies.push(body);
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
        return new Response(
          JSON.stringify({
            object: { sha: "commit2", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });
    const result = await backend.writeFiles({
      "manifest.json": "{}",
      "cursor-user--settings.json": '{"a":1}',
      "cursor-chat.json": "{}",
    });
    expect(result.ok).toBe(true);
    const tree = treeBodies[0] as { tree: Array<{ path: string }> };
    const paths = tree.tree.map((entry) => entry.path).sort();
    expect(paths).toEqual([
      "cursor-sync/cursor-chat.json",
      "cursor-sync/cursor-user/settings.json",
      "cursor-sync/manifest.json",
    ]);
    expect(paths.some((p) => p.includes("--"))).toBe(false);
  });

  it("renames leftover dashed files without re-uploading blobs", async () => {
    let blobPosts = 0;
    const treeBodies: unknown[] = [];
    const commitBodies: unknown[] = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({
            object: { sha: "refsha", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha") && method === "GET") {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha") && method === "GET") {
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/cursor-user--settings.json",
                mode: "100644",
                type: "blob",
                sha: "blob-settings",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-settings") && method === "GET") {
        return new Response(
          JSON.stringify({
            sha: "blob-settings",
            encoding: "utf-8",
            content: "{}",
            size: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        blobPosts += 1;
        return new Response(JSON.stringify({ sha: "blob-new" }), { status: 201 });
      }
      if (url.includes("/git/trees") && method === "POST") {
        treeBodies.push(body);
        return new Response(JSON.stringify({ sha: "tree2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/commits") && method === "POST") {
        commitBodies.push(body);
        return new Response(JSON.stringify({ sha: "commit2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/git/refs/heads/main") && method === "PATCH") {
        return new Response(
          JSON.stringify({
            object: { sha: "commit2", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected " + method + " " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });
    const snap = await backend.getSnapshot({ onlyFiles: ["cursor-user--settings.json"] });
    expect(snap.ok).toBe(true);
    expect(backend.hasLeftoverDashed()).toBe(true);

    const result = await backend.writeFiles({});
    expect(result.ok).toBe(true);
    expect(blobPosts).toBe(0);
    expect(backend.hasLeftoverDashed()).toBe(false);
    const tree = treeBodies[0] as {
      tree: Array<{ path: string; sha: string | null }>;
    };
    expect(tree.tree).toEqual(
      expect.arrayContaining([
        {
          path: "cursor-sync/cursor-user/settings.json",
          mode: "100644",
          type: "blob",
          sha: "blob-settings",
        },
        {
          path: "cursor-sync/cursor-user--settings.json",
          mode: "100644",
          type: "blob",
          sha: null,
        },
      ])
    );
    expect(tree.tree).toHaveLength(2);
    expect(commitBodies[0]).toMatchObject({
      message: "Cursor Sync: nest repo backup paths",
    });
  });

  it("deletes leftover dashed files without overwriting nested content", async () => {
    const treeBodies: unknown[] = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({
            object: { sha: "refsha", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha") && method === "GET") {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha") && method === "GET") {
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/cursor-user--settings.json",
                mode: "100644",
                type: "blob",
                sha: "blob-dashed",
              },
              {
                path: "cursor-sync/cursor-user/settings.json",
                mode: "100644",
                type: "blob",
                sha: "blob-nested",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/") && method === "GET") {
        return new Response(
          JSON.stringify({
            sha: "blob-nested",
            encoding: "utf-8",
            content: "nested",
            size: 6,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        return new Response(JSON.stringify({ sha: "blob-new" }), { status: 201 });
      }
      if (url.includes("/git/trees") && method === "POST") {
        treeBodies.push(body);
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
        return new Response(
          JSON.stringify({
            object: { sha: "commit2", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });
    await backend.getSnapshot();
    expect(backend.hasLeftoverDashed()).toBe(true);
    const result = await backend.writeFiles({});
    expect(result.ok).toBe(true);
    const tree = treeBodies[0] as {
      tree: Array<{ path: string; sha: string | null }>;
    };
    expect(tree.tree).toEqual([
      {
        path: "cursor-sync/cursor-user--settings.json",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ]);
  });

  it("deletes dashed-only leftovers without a nested sha:null path", async () => {
    const treeBodies: unknown[] = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return new Response(
          JSON.stringify({
            object: { sha: "refsha", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha") && method === "GET") {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha") && method === "GET") {
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/cursor-user--settings.json",
                mode: "100644",
                type: "blob",
                sha: "blob-settings",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-settings") && method === "GET") {
        return new Response(
          JSON.stringify({
            sha: "blob-settings",
            encoding: "utf-8",
            content: "{}",
            size: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs") && method === "POST") {
        return new Response(JSON.stringify({ sha: "blob-new" }), { status: 201 });
      }
      if (url.includes("/git/trees") && method === "POST") {
        treeBodies.push(body);
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
        return new Response(
          JSON.stringify({
            object: { sha: "commit2", type: "commit" },
            ref: "refs/heads/main",
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });
    await backend.getSnapshot();
    const result = await backend.writeFiles(
      {},
      { deleteNames: ["cursor-user--settings.json"] }
    );
    expect(result.ok).toBe(true);
    const tree = treeBodies[0] as {
      tree: Array<{ path: string; sha: string | null }>;
    };
    expect(tree.tree).toEqual([
      {
        path: "cursor-sync/cursor-user--settings.json",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ]);
    expect(tree.tree.some((entry) => entry.path.includes("cursor-user/settings"))).toBe(
      false
    );
  });
});
