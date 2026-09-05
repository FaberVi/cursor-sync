import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const showSyncFailureWithDebugMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

const executePushMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const executePullMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const isPushLockedMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
const isPullLockedMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("content")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => true, size: 100 }),
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sync-debug.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-debug.js")>();
  return {
    ...actual,
    showSyncFailureWithDebug: showSyncFailureWithDebugMock,
  };
});

vi.mock("../src/push.js", () => ({
  executePush: executePushMock,
  isPushLocked: isPushLockedMock,
}));

vi.mock("../src/pull.js", () => ({
  executePull: executePullMock,
  isPullLocked: isPullLockedMock,
}));

vi.mock("../src/chat-sync.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chat-sync.js")>(
    "../src/chat-sync.js"
  );
  return {
    ...actual,
    isChatSyncEnabled: vi.fn(() => false),
    computeChatSyncLocalFingerprint: vi.fn(async () => "chat-fingerprint"),
    readStoredChatSyncFingerprint: vi.fn(async () => undefined),
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

function extensionVersion(): string {
  return (
    JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
}

describe("scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start when schedule.enabled is false", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return false;
        if (key === "schedule.interval") return 30;
        if (key === "schedule.intervalUnit") return "minutes";
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);

    vi.advanceTimersByTime(120_000);
    stopScheduler();
  });

  it("enforces minimum interval of 30 seconds", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.interval") return 5;
        if (key === "schedule.intervalUnit") return "seconds";
        return undefined;
      },
      has: () => true,
      inspect: (key: string) => {
        if (key === "schedule.interval") {
          return { globalValue: 5 };
        }
        return undefined;
      },
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    vi.spyOn(Math, "random").mockReturnValue(0);

    const pushModule = await import("../src/push.js");
    const pushSpy = vi.spyOn(pushModule, "executePush").mockResolvedValue(true);

    const { startScheduler, stopScheduler, scheduledSyncActionResolver } = await import(
      "../src/scheduler.js"
    );
    vi.spyOn(scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "push",
    });

    startScheduler(mockContext());

    await vi.advanceTimersByTimeAsync(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushSpy).toHaveBeenCalledTimes(2);

    stopScheduler();
    pushSpy.mockRestore();
  });

  it("stops timer on stopScheduler", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.interval") return 5;
        if (key === "schedule.intervalUnit") return "minutes";
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    vi.spyOn(Math, "random").mockReturnValue(0);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);
    stopScheduler();

    vi.advanceTimersByTime(10 * 60 * 1000);
  });
});

describe("determineSyncAction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function context(): import("vscode").ExtensionContext {
    return {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: {
        get: async () => "fake-token",
        store: async () => {},
        delete: async () => {},
        onDidChange: () => ({ dispose: () => {} }),
      },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;
  }

  async function mockRepoConfig(repo = "acme/backup"): Promise<void> {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "destination.repo") return repo;
        if (key === "destination.branch") return "main";
        if (key === "destination.path") return "cursor-sync";
        if (key === "chats.syncEnabled") return false;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);
  }

  async function mockClone(options: {
    relation: "equal" | "ahead" | "behind" | "diverged" | "empty";
    local?: Record<string, string>;
    clone?: Record<string, string>;
    stateLocal?: Record<string, string>;
    completedFileSync?: boolean;
    nested?: boolean;
    token?: string | null;
  }): Promise<void> {
    await mockRepoConfig();
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      destination: {
        type: "repo",
        owner: "acme",
        repo: "backup",
        branch: "main",
        basePath: "cursor-sync",
      },
      localChecksums: options.stateLocal ?? options.local ?? {},
      remoteChecksums: options.clone ?? {},
      completedFileSync: options.completedFileSync,
    });
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue(
      options.token === null ? undefined : (options.token ?? "fake-token")
    );
    const clone = await import("../src/sync-clone.js");
    vi.spyOn(clone, "ensureSyncClone").mockResolvedValue({
      clonePath: "/tmp/clone",
      identity: {
        owner: "acme",
        repo: "backup",
        branch: "main",
        basePath: "cursor-sync",
      },
      empty: options.relation === "empty",
    });
    vi.spyOn(clone, "relationToOrigin").mockResolvedValue(options.relation);
    vi.spyOn(clone, "hasNestedSyncFiles").mockResolvedValue(options.nested === true);
    const copy = await import("../src/sync-copy.js");
    vi.spyOn(copy, "hashCursorSyncFiles").mockResolvedValue(options.local ?? {});
    vi.spyOn(copy, "hashCloneSyncFiles").mockResolvedValue(options.clone ?? {});
  }

  it("returns not_configured when no repository is set", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: () => undefined,
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({
      action: "error",
      reason: "not_configured",
    });
  });

  it("returns error when no token available", async () => {
    await mockClone({ relation: "equal", token: null });
    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({
      action: "error",
      reason: "no_token",
    });
  });

  it("returns none when clone equals origin and Cursor hashes match", async () => {
    const hashes = { "cursor-user/settings.json": "aaa111" };
    await mockClone({
      relation: "equal",
      local: hashes,
      clone: hashes,
      completedFileSync: true,
    });
    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({ action: "none" });
  });

  it("returns pull when origin is ahead", async () => {
    await mockClone({ relation: "behind", completedFileSync: true });
    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({ action: "pull" });
  });

  it("returns push when clone is ahead of origin", async () => {
    await mockClone({ relation: "ahead", completedFileSync: true });
    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({ action: "push" });
  });

  it("returns error when clone and origin have diverged", async () => {
    await mockClone({ relation: "diverged", completedFileSync: true });
    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({
      action: "error",
      reason: "diverged",
    });
  });

  it("returns pull when never synced and nested clone files already exist", async () => {
    await mockClone({
      relation: "equal",
      local: { "cursor-user/settings.json": "local" },
      clone: { "cursor-user/settings.json": "remote" },
      completedFileSync: false,
      nested: true,
    });
    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({ action: "pull" });
  });

  it("returns push when never synced and the clone has no nested files", async () => {
    await mockClone({
      relation: "equal",
      local: { "cursor-user/settings.json": "local" },
      clone: {},
      completedFileSync: false,
      nested: false,
    });
    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({ action: "push" });
  });

  it("does not treat matching chat fingerprint and checksum as a Cursor diff", async () => {
    const { computeChecksum } = await import("../src/packaging.js");
    const raw = '{"v":1}';
    const sum = computeChecksum(Buffer.from(raw, "utf8"));
    const hashes = { "cursor-user/settings.json": "aaa111" };
    await mockClone({
      relation: "equal",
      local: hashes,
      clone: hashes,
      stateLocal: { ...hashes, "dot-cursor/cursor-chat.json": sum },
      completedFileSync: true,
    });
    const chat = await import("../src/chat-sync.js");
    vi.spyOn(chat, "isChatSyncEnabled").mockReturnValue(true);
    vi.spyOn(chat, "computeChatSyncLocalFingerprint").mockResolvedValue("fp");
    vi.spyOn(chat, "readStoredChatSyncFingerprint").mockResolvedValue("fp");
    const copy = await import("../src/sync-copy.js");
    vi.spyOn(copy, "readCloneChatRaw").mockResolvedValue(raw);

    const { determineSyncAction } = await import("../src/scheduler.js");
    expect(await determineSyncAction(context())).toEqual({ action: "none" });
  });
});
