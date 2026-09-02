import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const showSyncFailureWithDebugMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

const determineSyncActionMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("../src/sync-debug.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-debug.js")>();
  return {
    ...actual,
    showSyncFailureWithDebug: showSyncFailureWithDebugMock,
  };
});

vi.mock("../src/scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scheduler.js")>();
  return {
    ...actual,
    determineSyncAction: determineSyncActionMock,
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("content")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({
    isDirectory: () => true,
    isFile: () => true,
    size: 100,
  }),
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  lstat: vi.fn().mockResolvedValue({
    isDirectory: () => true,
    isFile: () => true,
    size: 100,
  }),
}));

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

function extensionVersion(): string {
  return (
    JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
}

describe("push/pull debug wiring", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    showSyncFailureWithDebugMock.mockClear();

    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "syncProfileName") return "default";
        if (key === "safeMode") return false;
        if (key === "chats.syncEnabled") return false;
        if (key === "destination.type") return "gist";
        if (key === "destination.repo") return "";
        if (key === "destination.branch") return "main";
        if (key === "destination.path") return "cursor-sync";
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it(
    "calls showSyncFailureWithDebug on push gist create failure",
    async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/gists") && method === "GET") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [],
        } as Response;
      }

      if (url.includes("/gists") && method === "POST") {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({ message: "Internal Server Error" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(true);
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "addSyncHistoryEntry").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([]);
    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({
      cursorUser: "/tmp/cursor-user",
      dotCursor: "/tmp/.cursor",
    });

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [context, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(context).toBeDefined();
    expect(failure).toMatchObject({
      operation: "push",
      direction: "push",
      trigger: "manual",
      category: "NETWORK_ERROR",
      statusCode: 500,
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toContain("Server error (500)");
    expect(options).toMatchObject({
      title: expect.stringContaining("Push failed:"),
    });
  },
  20_000
  );

  it("calls showSyncFailureWithDebug on pull getGist failure", async () => {
    const gistId = "abcdef1234567890abcdef1234567890";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith(`/gists/${gistId}`)) {
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          json: async () => ({ message: "Not Found" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId,
      localChecksums: {},
      remoteChecksums: {},
    });
    vi.spyOn(diagnostics, "addSyncHistoryEntry").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const { executePull } = await import("../src/pull.js");
    const result = await executePull(mockContext(), { trigger: "scheduled" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "pull",
      direction: "pull",
      trigger: "scheduled",
      category: "UNKNOWN",
      statusCode: 404,
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toBe("Not Found");
    expect(options).toMatchObject({
      title: expect.stringContaining("Pull failed:"),
    });
  });

  it("calls showSyncFailureWithDebug on push conflict blocker with warning metadata", async () => {
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(true);
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "pull",
      gistId: "abcdef1234567890abcdef1234567890",
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    });
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const conflicts = await import("../src/conflicts.js");
    vi.spyOn(conflicts, "detectConflicts").mockResolvedValue([
      {
        relativeSyncKey: "cursor-user/settings.json",
        localChecksum: "local",
        remoteChecksum: "remote",
      },
    ]);
    vi.spyOn(conflicts, "getResolutionForKey").mockReturnValue(undefined);

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "push",
      direction: "push",
      trigger: "manual",
      category: "CONFLICT",
      conflictCount: 1,
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toBe(
      "1 conflict(s) detected. Resolve them before pushing."
    );
    expect(options).toMatchObject({
      level: "warning",
      title: "1 conflict(s) detected. Resolve them before pushing.",
    });
  });

  const sampleConflict = {
    relativeSyncKey: "cursor-user/settings.json",
    localChecksum: "local",
    remoteChecksum: "remote",
  };

  async function setupPushConflictBase() {
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(true);
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    const addHistory = vi
      .spyOn(diagnostics, "addSyncHistoryEntry")
      .mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "pull",
      gistId: "abcdef1234567890abcdef1234567890",
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    });
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const conflicts = await import("../src/conflicts.js");
    vi.spyOn(conflicts, "detectConflicts").mockResolvedValue([sampleConflict]);
    return { addHistory, conflicts };
  }

  it("does not record Unresolved conflicts history when push conflicts are fully resolved in-prompt", async () => {
    const { addHistory, conflicts } = await setupPushConflictBase();
    const vscode = await import("vscode");
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(
      async (cmd: string) => {
        if (cmd === "cursorSync.resolveConflicts") {
          conflicts.setPendingResolutionsForTests([
            {
              relativeSyncKey: sampleConflict.relativeSyncKey,
              resolution: "keepLocal",
            },
          ]);
        }
      }
    );

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(
      addHistory.mock.calls.some(
        (call) =>
          (call[1] as { error?: string }).error === "Unresolved conflicts"
      )
    ).toBe(false);
    expect(
      showSyncFailureWithDebugMock.mock.calls.some(
        (call) => (call[1] as { category?: string }).category === "CONFLICT"
      )
    ).toBe(false);
    await conflicts.clearConflicts();
  });

  it("records Unresolved conflicts history after push skip/cancel", async () => {
    const { addHistory, conflicts } = await setupPushConflictBase();
    const vscode = await import("vscode");
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(executeCommand).toHaveBeenCalledWith("cursorSync.resolveConflicts");
    expect(addHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        success: false,
        error: "Unresolved conflicts",
        direction: "push",
      })
    );
    expect(showSyncFailureWithDebugMock).toHaveBeenCalled();
    const toastIdx = showSyncFailureWithDebugMock.mock.invocationCallOrder[0];
    const resolveIdx = executeCommand.mock.invocationCallOrder.find(
      (_n, i) =>
        executeCommand.mock.calls[i]?.[0] === "cursorSync.resolveConflicts"
    );
    expect(resolveIdx).toBeDefined();
    expect(toastIdx).toBeGreaterThan(resolveIdx!);
    await conflicts.clearConflicts();
  });

  it("records Unresolved conflicts on scheduled push without prompting", async () => {
    const { addHistory, conflicts } = await setupPushConflictBase();
    const vscode = await import("vscode");
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "scheduled" });

    expect(result).toBe(false);
    expect(executeCommand).not.toHaveBeenCalledWith(
      "cursorSync.resolveConflicts"
    );
    expect(addHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        error: "Unresolved conflicts",
        trigger: "scheduled",
      })
    );
    await conflicts.clearConflicts();
  });

  it("continues push when conflicts were already resolved keepRemote", async () => {
    const { addHistory, conflicts } = await setupPushConflictBase();
    conflicts.setPendingResolutionsForTests([
      {
        relativeSyncKey: sampleConflict.relativeSyncKey,
        resolution: "keepRemote",
      },
    ]);

    const pkg = await import("../src/push-package.js");
    const packageSpy = vi.spyOn(pkg, "packagePushFiles").mockResolvedValue({
      packaged: new Map(),
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: "",
        sourceMachineId: "",
        sourceOS: "win32",
        files: {},
      },
      delta: {
        filesToUpload: {},
        uploadedSyncKeys: [],
        unchangedCount: 0,
        deleteNames: [],
        isNoOp: true,
      },
      chatForDelta: undefined,
      chatBundleCount: 0,
    });
    const write = await import("../src/push-write.js");
    vi.spyOn(write, "writePushRemote").mockResolvedValue(true);

    const vscode = await import("vscode");
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(true);
    expect(executeCommand).not.toHaveBeenCalledWith(
      "cursorSync.resolveConflicts"
    );
    expect(
      addHistory.mock.calls.some(
        (call) =>
          (call[1] as { error?: string }).error === "Unresolved conflicts"
      )
    ).toBe(false);
    expect(packageSpy).toHaveBeenCalled();
    await conflicts.clearConflicts();
  });

  async function setupPullConflictBase() {
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    const addHistory = vi
      .spyOn(diagnostics, "addSyncHistoryEntry")
      .mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abcdef1234567890abcdef1234567890",
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    });
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);
    vi.spyOn(diagnostics, "saveSyncState").mockResolvedValue(undefined);

    const remote = await import("../src/remote/index.js");
    vi.spyOn(remote, "createRemoteBackend").mockReturnValue({
      type: "gist",
      remoteLabel: () => "gist",
      remoteUrl: () => "https://gist.github.com/x",
      discover: async () => ({
        ok: true as const,
        data: { id: "abcdef1234567890abcdef1234567890", htmlUrl: "u" },
      }),
      getSnapshot: async () => ({
        ok: true as const,
        data: {
          id: "abcdef1234567890abcdef1234567890",
          htmlUrl: "u",
          files: {
            "manifest.json": JSON.stringify({
              files: {
                "cursor-user/settings.json": { checksum: "remote" },
              },
            }),
          },
        },
      }),
      writeFiles: async () => ({
        ok: true as const,
        data: {
          id: "abcdef1234567890abcdef1234567890",
          htmlUrl: "u",
          created: false,
        },
      }),
    } as import("../src/remote/index.js").RemoteSyncBackend);

    const conflicts = await import("../src/conflicts.js");
    vi.spyOn(conflicts, "detectConflicts").mockResolvedValue([sampleConflict]);
    return { addHistory, conflicts };
  }

  it("does not record Unresolved conflicts history when pull conflicts are fully resolved in-prompt", async () => {
    const { addHistory, conflicts } = await setupPullConflictBase();
    const vscode = await import("vscode");
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(
      async (cmd: string) => {
        if (cmd === "cursorSync.resolveConflicts") {
          conflicts.setPendingResolutionsForTests([
            {
              relativeSyncKey: sampleConflict.relativeSyncKey,
              resolution: "keepLocal",
            },
          ]);
        }
      }
    );

    const { fetchPullRemote } = await import("../src/pull-remote-fetch.js");
    const result = await fetchPullRemote(
      mockContext(),
      "manual",
      { report: () => {} },
      false
    );

    expect(result).toEqual({ ok: false });
    expect(
      addHistory.mock.calls.some(
        (call) =>
          (call[1] as { error?: string }).error === "Unresolved conflicts"
      )
    ).toBe(false);
    expect(
      showSyncFailureWithDebugMock.mock.calls.some(
        (call) => (call[1] as { category?: string }).category === "CONFLICT"
      )
    ).toBe(false);
    await conflicts.clearConflicts();
  });

  it("records Unresolved conflicts history after pull skip/cancel", async () => {
    const { addHistory, conflicts } = await setupPullConflictBase();
    const vscode = await import("vscode");
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { fetchPullRemote } = await import("../src/pull-remote-fetch.js");
    const result = await fetchPullRemote(
      mockContext(),
      "manual",
      { report: () => {} },
      false
    );

    expect(result).toEqual({ ok: false });
    expect(executeCommand).toHaveBeenCalledWith("cursorSync.resolveConflicts");
    expect(addHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        success: false,
        error: "Unresolved conflicts",
        direction: "pull",
      })
    );
    await conflicts.clearConflicts();
  });

  it("records Unresolved conflicts on scheduled pull without prompting", async () => {
    const { addHistory, conflicts } = await setupPullConflictBase();
    const vscode = await import("vscode");
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { fetchPullRemote } = await import("../src/pull-remote-fetch.js");
    const result = await fetchPullRemote(
      mockContext(),
      "scheduled",
      { report: () => {} },
      false
    );

    expect(result).toEqual({ ok: false });
    expect(executeCommand).not.toHaveBeenCalledWith(
      "cursorSync.resolveConflicts"
    );
    expect(addHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        error: "Unresolved conflicts",
        trigger: "scheduled",
      })
    );
    await conflicts.clearConflicts();
  });

  it("continues pull when conflicts were already resolved", async () => {
    const { addHistory, conflicts } = await setupPullConflictBase();
    conflicts.setPendingResolutionsForTests([
      {
        relativeSyncKey: sampleConflict.relativeSyncKey,
        resolution: "keepLocal",
      },
    ]);
    const vscode = await import("vscode");
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { fetchPullRemote } = await import("../src/pull-remote-fetch.js");
    const result = await fetchPullRemote(
      mockContext(),
      "manual",
      { report: () => {} },
      false
    );

    expect(result.ok).toBe(true);
    expect(executeCommand).not.toHaveBeenCalledWith(
      "cursorSync.resolveConflicts"
    );
    expect(
      addHistory.mock.calls.some(
        (call) =>
          (call[1] as { error?: string }).error === "Unresolved conflicts"
      )
    ).toBe(false);
    await conflicts.clearConflicts();
  });

  it("calls showSyncFailureWithDebug on push auth failure", async () => {
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(false);
    vi.spyOn(auth, "requireToken").mockResolvedValue(undefined);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "push",
      direction: "push",
      trigger: "manual",
      category: "AUTH_FAILED",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toBe(
      "GitHub token not configured. Configure your token to sync."
    );
    expect(failure.message).not.toMatch(/ghp_/);
    expect(options).toMatchObject({
      title: "GitHub token not configured. Configure your token to sync.",
    });
  });

  it("calls showSyncFailureWithDebug on pull auth failure", async () => {
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue(undefined);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abcdef1234567890abcdef1234567890",
      localChecksums: {},
      remoteChecksums: {},
    });
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const { executePull } = await import("../src/pull.js");
    const result = await executePull(mockContext(), { trigger: "scheduled" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "pull",
      direction: "pull",
      trigger: "scheduled",
      category: "AUTH_FAILED",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toBe(
      "GitHub token not configured. Configure your token to sync."
    );
    expect(failure.message).not.toMatch(/ghp_/);
    expect(options).toMatchObject({
      title: "GitHub token not configured. Configure your token to sync.",
    });
  });
});

describe("sync now debug wiring", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    showSyncFailureWithDebugMock.mockClear();
    determineSyncActionMock.mockReset();

    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "syncProfileName") return "default";
        if (key === "safeMode") return false;
        if (key === "chats.syncEnabled") return false;
        if (key === "destination.type") return "gist";
        if (key === "destination.repo") return "";
        if (key === "destination.branch") return "main";
        if (key === "destination.path") return "cursor-sync";
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls showSyncFailureWithDebug on determineSyncAction error", async () => {
    determineSyncActionMock.mockResolvedValue({
      action: "error",
      reason: "no_token",
    });

    const { executeSyncNow } = await import("../src/sync-now.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalled();
    const syncNowCall = showSyncFailureWithDebugMock.mock.calls.find(
      (call) => (call[1] as { operation?: string }).operation === "syncNow"
    );
    expect(syncNowCall).toBeDefined();
    const [, failure, options] = syncNowCall!;
    expect(failure).toMatchObject({
      operation: "syncNow",
      trigger: "manual",
      message: "no_token",
      category: "no_token",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({ title: "Sync failed: no_token" });
  });

  it("calls showSyncFailureWithDebug on determineSyncAction conflict", async () => {
    determineSyncActionMock.mockResolvedValue({
      action: "conflict",
      keys: ["cursor-user/settings.json", "dot-cursor/mcp.json"],
    });

    const conflicts = await import("../src/conflicts.js");
    await conflicts.registerPendingConflicts([
      {
        relativeSyncKey: "cursor-user/settings.json",
        localChecksum: "a",
        remoteChecksum: "b",
        baseChecksum: "c",
      },
      {
        relativeSyncKey: "dot-cursor/mcp.json",
        localChecksum: "d",
        remoteChecksum: "e",
        baseChecksum: "f",
      },
    ]);

    const order: string[] = [];
    const progressMod = await import("../src/sync-progress-events.js");
    vi.spyOn(progressMod, "createSidebarSyncProgress").mockReturnValue({
      report: () => {
        order.push("report");
      },
      complete: (ok: boolean) => {
        order.push(`complete:${ok}`);
      },
      get percent() {
        return 0;
      },
    });

    const vscode = await import("vscode");
    const executeCommandSpy = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockImplementation(async (cmd: string) => {
        if (cmd === "cursorSync.resolveConflicts") {
          order.push("resolve");
        }
      });

    const { executeSyncNow } = await import("../src/sync-now.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalled();
    const conflictCall = showSyncFailureWithDebugMock.mock.calls.find(
      (call) => (call[1] as { operation?: string }).operation === "syncNow"
    );
    expect(conflictCall).toBeDefined();
    const [, failure, options] = conflictCall!;
    expect(failure).toMatchObject({
      operation: "syncNow",
      trigger: "manual",
      category: "CONFLICT",
      conflictCount: 2,
      message: "2 conflict(s) detected. Resolve them first.",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({
      level: "warning",
      title: "2 conflict(s) detected. Resolve them first.",
    });
    expect(executeCommandSpy).toHaveBeenCalledWith("cursorSync.resolveConflicts");
    const resolveAt = order.indexOf("resolve");
    const completeAt = order.indexOf("complete:false");
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(completeAt).toBeGreaterThan(resolveAt);
    await conflicts.clearConflicts();
  });

  it("does not toast CONFLICT on syncNow after full in-prompt resolve", async () => {
    determineSyncActionMock.mockResolvedValue({
      action: "conflict",
      keys: ["cursor-user/settings.json"],
    });

    const conflicts = await import("../src/conflicts.js");
    await conflicts.registerPendingConflicts([
      {
        relativeSyncKey: "cursor-user/settings.json",
        localChecksum: "a",
        remoteChecksum: "b",
        baseChecksum: "c",
      },
    ]);

    const vscode = await import("vscode");
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(
      async (cmd: string) => {
        if (cmd === "cursorSync.resolveConflicts") {
          await conflicts.registerPendingConflicts([]);
        }
      }
    );

    const { executeSyncNow } = await import("../src/sync-now.js");
    await executeSyncNow(mockContext());

    expect(
      showSyncFailureWithDebugMock.mock.calls.some(
        (call) => (call[1] as { category?: string }).category === "CONFLICT"
      )
    ).toBe(false);
    await conflicts.clearConflicts();
  });

  it("calls showSyncFailureWithDebug when executeSyncNow catches", async () => {
    determineSyncActionMock.mockRejectedValue(new Error("scheduler blew up"));

    const { executeSyncNow } = await import("../src/sync-now.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "syncNow",
      trigger: "manual",
      message: "scheduler blew up",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({ title: "Sync failed: scheduler blew up" });
  });

  it(
    "does not duplicate debug toast when delegating to push failure",
    async () => {
    determineSyncActionMock.mockResolvedValue({ action: "push" });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/gists") && method === "GET") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [],
        } as Response;
      }

      if (url.includes("/gists") && method === "POST") {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({ message: "Internal Server Error" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(true);
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "addSyncHistoryEntry").mockResolvedValue(undefined);

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([]);
    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({
      cursorUser: "/tmp/cursor-user",
      dotCursor: "/tmp/.cursor",
    });

    const { executeSyncNow } = await import("../src/sync-now.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({ operation: "push", direction: "push" });
  },
  20_000
  );
});
