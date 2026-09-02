import "./remote-backend-harness.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockFetch, restoreRemoteFetchAfterEach } from "./remote-backend-harness.js";
import { RepoBackend } from "../src/remote/repo-backend.js";
import { writePushRemote } from "../src/push-write.js";
import type { PushPackageResult } from "../src/push-package.js";
import { __setMockGlobalConfig } from "./__mocks__/vscode.js";

vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
    getLogger: () => ({ appendLine: vi.fn() }),
    addSyncHistoryEntry: vi.fn().mockResolvedValue(undefined),
    saveSyncState: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/conflicts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/conflicts.js")>();
  return {
    ...actual,
    clearConflicts: vi.fn().mockResolvedValue(undefined),
  };
});

const showSyncFailureWithDebugMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

vi.mock("../src/sync-debug.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-debug.js")>();
  return {
    ...actual,
    showSyncFailureWithDebug: showSyncFailureWithDebugMock,
  };
});

function mockContext(): import("vscode").ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-test" },
    globalState: {
      get: vi.fn().mockReturnValue("test-client-id"),
      update: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockReturnValue([]),
    },
    secrets: {
      get: async () => "ghp_test_token",
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

const noOpPackaged: PushPackageResult = {
  packaged: new Map(),
  manifest: {
    schemaVersion: 1,
    syncProfileName: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceMachineId: "test",
    sourceOS: "win32",
    files: {},
  },
  delta: {
    filesToUpload: {},
    uploadedSyncKeys: [],
    unchangedCount: 2,
    deleteNames: [],
    isNoOp: true,
  },
  chatForDelta: undefined,
  chatBundleCount: 0,
};

function leftoverSnapshotAndWriteMock(options: { failTree?: boolean }): void {
  mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("google-analytics.com")) {
      return new Response("{}", { status: 204 });
    }
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
      if (options.failTree) {
        return new Response(JSON.stringify({ message: "tree failed" }), {
          status: 422,
        });
      }
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
    return new Response(JSON.stringify({ message: "unexpected " + method + " " + url }), {
      status: 500,
    });
  });
}

describe("writePushRemote leftover nested migrate", () => {
  restoreRemoteFetchAfterEach();

  beforeEach(() => {
    showSyncFailureWithDebugMock.mockClear();
    __setMockGlobalConfig({ "chats.syncEnabled": false });
  });

  it("migrates leftover dashed paths on a content no-op and still reports already in sync", async () => {
    leftoverSnapshotAndWriteMock({});
    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });
    await backend.getSnapshot();
    expect(backend.hasLeftoverDashed()).toBe(true);

    const ok = await writePushRemote(
      mockContext(),
      "manual",
      { report: () => {} },
      backend,
      undefined,
      {},
      new Set(),
      { ok: true, data: { id: "acme/backup", htmlUrl: "", files: {}, allFileNames: [] } },
      noOpPackaged
    );
    expect(ok).toBe(true);
    expect(backend.hasLeftoverDashed()).toBe(false);
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("fails the push when leftover migrate write fails", async () => {
    leftoverSnapshotAndWriteMock({ failTree: true });
    const backend = new RepoBackend({
      pat: "token",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "cursor-sync",
    });
    await backend.getSnapshot();
    expect(backend.hasLeftoverDashed()).toBe(true);

    const diagnostics = await import("../src/diagnostics.js");
    const ok = await writePushRemote(
      mockContext(),
      "manual",
      { report: () => {} },
      backend,
      undefined,
      {},
      new Set(),
      { ok: true, data: { id: "acme/backup", htmlUrl: "", files: {}, allFileNames: [] } },
      noOpPackaged
    );
    expect(ok).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalled();
    expect(diagnostics.addSyncHistoryEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false })
    );
  });
});
