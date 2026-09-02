import { mockFetch, restoreRemoteFetchAfterEach } from "./remote-backend-harness.js";
import { describe, it, expect } from "vitest";
import {
  TREE_CHUNK_SIZE,
  createGitTreesIncremental,
  type GitTreeEntry,
} from "../src/remote/repo-git-write.js";

function blobEntry(i: number): GitTreeEntry {
  return {
    path: `cursor-sync/f-${i}.json`,
    mode: "100644",
    type: "blob",
    sha: `blob-${i}`,
  };
}

describe("createGitTreesIncremental", () => {
  restoreRemoteFetchAfterEach();

  it("posts a single tree with base_tree when under the chunk size", async () => {
    const bodies: Array<{ tree: GitTreeEntry[]; base_tree?: string }> = [];
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/git/trees") && (init?.method ?? "GET") === "POST") {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ sha: "tree-out" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });

    const progress: Array<[number, number]> = [];
    const result = await createGitTreesIncremental({
      owner: "acme",
      repo: "backup",
      pat: "token",
      treeItems: [blobEntry(0), blobEntry(1)],
      baseTreeSha: "parent-tree",
      onTreeProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sha).toBe("tree-out");
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.base_tree).toBe("parent-tree");
    expect(bodies[0]?.tree).toHaveLength(2);
    expect(progress).toEqual([[1, 1]]);
  });

  it("omits base_tree on the first chunk of an initial commit", async () => {
    const bodies: Array<{ tree: GitTreeEntry[]; base_tree?: string }> = [];
    mockFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ sha: "tree-init" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await createGitTreesIncremental({
      owner: "acme",
      repo: "empty",
      pat: "token",
      treeItems: [blobEntry(0)],
    });

    expect(result.ok).toBe(true);
    expect(bodies[0]?.base_tree).toBeUndefined();
  });

  it("chains chunked creates with the previous tree SHA as base_tree", async () => {
    const bodies: Array<{ tree: GitTreeEntry[]; base_tree?: string }> = [];
    let n = 0;
    mockFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      n += 1;
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ sha: `tree-${n}` }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const items = Array.from({ length: TREE_CHUNK_SIZE + 2 }, (_, i) => blobEntry(i));
    const progress: Array<[number, number]> = [];
    const result = await createGitTreesIncremental({
      owner: "acme",
      repo: "backup",
      pat: "token",
      treeItems: items,
      baseTreeSha: "parent-tree",
      onTreeProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sha).toBe("tree-2");
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.tree).toHaveLength(TREE_CHUNK_SIZE);
    expect(bodies[0]?.base_tree).toBe("parent-tree");
    expect(bodies[1]?.tree).toHaveLength(2);
    expect(bodies[1]?.base_tree).toBe("tree-1");
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("stops after a failed chunk and does not post the next", async () => {
    let posts = 0;
    mockFetch(async () => {
      posts += 1;
      if (posts === 1) {
        return new Response(JSON.stringify({ sha: "tree-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          message:
            "Sorry, your request timed out. It's likely that your input was too large to process.",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      );
    });

    const items = Array.from({ length: TREE_CHUNK_SIZE + 1 }, (_, i) => blobEntry(i));
    const result = await createGitTreesIncremental({
      owner: "acme",
      repo: "backup",
      pat: "token",
      treeItems: items,
      baseTreeSha: "parent-tree",
    });

    expect(result.ok).toBe(false);
    expect(posts).toBe(2);
    if (!result.ok) {
      expect(result.error.message).toMatch(/timed out/i);
    }
  });

  it("rejects an empty tree list", async () => {
    const result = await createGitTreesIncremental({
      owner: "acme",
      repo: "backup",
      pat: "token",
      treeItems: [],
    });
    expect(result.ok).toBe(false);
  });
});
