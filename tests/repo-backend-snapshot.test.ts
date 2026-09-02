import { mockFetch, restoreRemoteFetchAfterEach } from "./remote-backend-harness.js";
import { describe, it, expect, vi } from "vitest";
import { remoteSnapshotFileNames } from "../src/remote/index.js";
import { RepoBackend } from "../src/remote/repo-backend.js";

describe("RepoBackend snapshot", () => {
  restoreRemoteFetchAfterEach();

  it("getSnapshot returns empty files when branch missing", async () => {
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response("{}", { status: 500 });
    });

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

  it("getSnapshot returns empty files when GitHub reports an empty repository (HTTP 409)", async () => {
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ message: "Git Repository is empty." }), {
          status: 409,
        });
      }
      return new Response("{}", { status: 500 });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "empty",
    });
    const snap = await backend.getSnapshot();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.data.files).toEqual({});
      expect(snap.data.allFileNames).toEqual([]);
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
  it("reuses ref/commit/tree on a second getSnapshot and fetches only requested blobs", async () => {
    const counts = { ref: 0, commit: 0, tree: 0, blob: 0 };
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        counts.ref += 1;
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: "refsha", type: "commit" },
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha")) {
        counts.commit += 1;
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha")) {
        counts.tree += 1;
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/manifest.json",
                mode: "100644",
                type: "blob",
                sha: "blob-manifest",
              },
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
      if (url.includes("/git/blobs/blob-manifest")) {
        counts.blob += 1;
        return new Response(
          JSON.stringify({
            sha: "blob-manifest",
            encoding: "utf-8",
            content: '{"files":{}}',
            size: 11,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-settings")) {
        counts.blob += 1;
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
      return new Response(JSON.stringify({ message: "unexpected " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const first = await backend.getSnapshot({ onlyFiles: ["manifest.json"] });
    const second = await backend.getSnapshot({
      onlyFiles: ["cursor-user--settings.json"],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) {
      expect(first.data.files).toEqual({ "manifest.json": '{"files":{}}' });
      expect(first.data.allFileNames.sort()).toEqual([
        "cursor-user--settings.json",
        "manifest.json",
      ]);
    }
    if (second.ok) {
      expect(second.data.files).toEqual({
        "cursor-user--settings.json": "{}",
      });
    }
    expect(backend.hasLeftoverDashed()).toBe(true);
    expect(counts.ref).toBe(1);
    expect(counts.commit).toBe(1);
    expect(counts.tree).toBe(1);
    expect(counts.blob).toBe(2);
  });

  it("getSnapshot reports onFileProgress after each downloaded blob", async () => {
    const progress: Array<[number, number]> = [];
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: "refsha", type: "commit" },
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha")) {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha")) {
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/manifest.json",
                mode: "100644",
                type: "blob",
                sha: "blob-manifest",
              },
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
      if (url.includes("/git/blobs/blob-manifest")) {
        return new Response(
          JSON.stringify({
            sha: "blob-manifest",
            encoding: "utf-8",
            content: '{"files":{}}',
            size: 11,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-settings")) {
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
      return new Response(JSON.stringify({ message: "unexpected " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const snap = await backend.getSnapshot({
      onFileProgress: (completed, total) => {
        progress.push([completed, total]);
      },
    });
    expect(snap.ok).toBe(true);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("does not report onFileProgress when a blob fetch fails", async () => {
    const progress: Array<[number, number]> = [];
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: "refsha", type: "commit" },
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha")) {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha")) {
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/manifest.json",
                mode: "100644",
                type: "blob",
                sha: "blob-manifest",
              },
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
      if (url.includes("/git/blobs/blob-manifest")) {
        return new Response(
          JSON.stringify({
            sha: "blob-manifest",
            encoding: "utf-8",
            content: '{"files":{}}',
            size: 11,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-settings")) {
        return new Response(JSON.stringify({ message: "not found" }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify({ message: "unexpected " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const snap = await backend.getSnapshot({
      onFileProgress: (completed, total) => {
        progress.push([completed, total]);
      },
    });
    expect(snap.ok).toBe(false);
    expect(progress).toEqual([[1, 2]]);
  });

  it("maps nested Git paths to gist-flat internal names", async () => {
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: "refsha", type: "commit" },
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha")) {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha")) {
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/manifest.json",
                mode: "100644",
                type: "blob",
                sha: "blob-manifest",
              },
              {
                path: "cursor-sync/cursor-user/settings.json",
                mode: "100644",
                type: "blob",
                sha: "blob-settings",
              },
              {
                path: "cursor-sync/cursor-chat.json",
                mode: "100644",
                type: "blob",
                sha: "blob-chat",
              },
              {
                path: "README.md",
                mode: "100644",
                type: "blob",
                sha: "blob-readme",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-manifest")) {
        return new Response(
          JSON.stringify({
            sha: "blob-manifest",
            encoding: "utf-8",
            content: "{}",
            size: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-settings")) {
        return new Response(
          JSON.stringify({
            sha: "blob-settings",
            encoding: "utf-8",
            content: '{"k":1}',
            size: 7,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-chat")) {
        return new Response(
          JSON.stringify({
            sha: "blob-chat",
            encoding: "utf-8",
            content: '{"chats":[]}',
            size: 12,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const snap = await backend.getSnapshot();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.data.files).toEqual({
        "manifest.json": "{}",
        "cursor-user--settings.json": '{"k":1}',
        "cursor-chat.json": '{"chats":[]}',
      });
      expect(snap.data.allFileNames?.sort()).toEqual([
        "cursor-chat.json",
        "cursor-user--settings.json",
        "manifest.json",
      ]);
    }
    expect(backend.hasLeftoverDashed()).toBe(false);
  });

  it("prefers nested content when both layouts exist and flags leftover dashed", async () => {
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: "refsha", type: "commit" },
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha")) {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha")) {
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
      if (url.includes("/git/blobs/blob-dashed")) {
        return new Response(
          JSON.stringify({
            sha: "blob-dashed",
            encoding: "utf-8",
            content: "old",
            size: 3,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-nested")) {
        return new Response(
          JSON.stringify({
            sha: "blob-nested",
            encoding: "utf-8",
            content: "new",
            size: 3,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const snap = await backend.getSnapshot();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.data.files).toEqual({
        "cursor-user--settings.json": "new",
      });
      expect(snap.data.allFileNames).toEqual(["cursor-user--settings.json"]);
    }
    expect(backend.hasLeftoverDashed()).toBe(true);
  });

  it("downloads blobs with concurrency 5 and reports progress", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const progress: Array<[number, number]> = [];
    const tree = Array.from({ length: 6 }, (_, i) => ({
      path: `cursor-sync/file-${i}.json`,
      mode: "100644",
      type: "blob" as const,
      sha: `blob-${i}`,
    }));
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: "refsha", type: "commit" },
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha")) {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha")) {
        return new Response(
          JSON.stringify({ sha: "treesha", truncated: false, tree }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      const blobMatch = url.match(/\/git\/blobs\/blob-(\d+)/);
      if (blobMatch) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inflight -= 1;
        const i = blobMatch[1];
        return new Response(
          JSON.stringify({
            sha: `blob-${i}`,
            encoding: "utf-8",
            content: `{"i":${i}}`,
            size: 8,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const snap = await backend.getSnapshot({
      onFileProgress: (completed, total) => {
        progress.push([completed, total]);
      },
    });
    expect(snap.ok).toBe(true);
    expect(maxInflight).toBe(5);
    expect(progress.at(-1)).toEqual([6, 6]);
    expect(progress).toHaveLength(6);
  });

  it("retries a single blob GET without re-fetching the others", async () => {
    vi.useFakeTimers();
    const blobGets: Record<string, number> = {};
    let failedOnce = false;
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { sha: "refsha", type: "commit" },
            url,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/commits/refsha")) {
        return new Response(
          JSON.stringify({ sha: "refsha", tree: { sha: "treesha" }, parents: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/trees/treesha")) {
        return new Response(
          JSON.stringify({
            sha: "treesha",
            truncated: false,
            tree: [
              {
                path: "cursor-sync/a.json",
                mode: "100644",
                type: "blob",
                sha: "blob-retry",
              },
              {
                path: "cursor-sync/b.json",
                mode: "100644",
                type: "blob",
                sha: "blob-ok",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-retry")) {
        blobGets["blob-retry"] = (blobGets["blob-retry"] ?? 0) + 1;
        if (!failedOnce) {
          failedOnce = true;
          return new Response(JSON.stringify({ message: "server" }), { status: 500 });
        }
        return new Response(
          JSON.stringify({
            sha: "blob-retry",
            encoding: "utf-8",
            content: "retried",
            size: 7,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/git/blobs/blob-ok")) {
        blobGets["blob-ok"] = (blobGets["blob-ok"] ?? 0) + 1;
        return new Response(
          JSON.stringify({
            sha: "blob-ok",
            encoding: "utf-8",
            content: "ok",
            size: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "unexpected " + url }), {
        status: 500,
      });
    });

    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
    });
    const pending = backend.getSnapshot();
    await vi.runAllTimersAsync();
    const snap = await pending;
    vi.useRealTimers();
    expect(snap.ok).toBe(true);
    expect(blobGets["blob-retry"]).toBe(2);
    expect(blobGets["blob-ok"]).toBe(1);
  });
});
