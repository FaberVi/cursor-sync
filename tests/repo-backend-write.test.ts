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
});
