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

describe("scheduled sync debug wiring", () => {
  beforeEach(async () => {
    vi.resetModules();
    showSyncFailureWithDebugMock.mockClear();
    executePushMock.mockReset().mockResolvedValue(true);
    executePullMock.mockReset().mockResolvedValue(true);
    isPushLockedMock.mockReset().mockReturnValue(false);
    isPullLockedMock.mockReset().mockReturnValue(false);

    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.interval") return 30;
        if (key === "schedule.intervalUnit") return "minutes";
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
    vi.restoreAllMocks();
  });

  it("skips scheduledTick entirely when schedule.enabled is false", async () => {
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

    const scheduler = await import("../src/scheduler.js");
    const determineSpy = vi
      .spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction")
      .mockResolvedValue({ action: "push" });

    await scheduler.scheduledTick(mockContext());

    expect(determineSpy).not.toHaveBeenCalled();
    expect(executePushMock).not.toHaveBeenCalled();
    expect(executePullMock).not.toHaveBeenCalled();
  });

  it("calls showSyncFailureWithDebug on determineSyncAction error", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "error",
      reason: "no_token",
    });

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "scheduler",
      trigger: "scheduled",
      message: "no_token",
      category: "no_token",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({ title: "Scheduled sync failed: no_token" });
  });

  it("skips scheduled sync on conflict without debug toast", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "conflict",
      keys: ["cursor-user/settings.json"],
    });

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
    expect(executePushMock).not.toHaveBeenCalled();
    expect(executePullMock).not.toHaveBeenCalled();
  });

  it("does not duplicate debug toast when scheduled pull fails via executePull", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull",
    });

    executePullMock.mockImplementation(async (context, options) => {
      const { executePull } = await vi.importActual<
        typeof import("../src/pull.js")
      >("../src/pull.js");
      return executePull(context, options);
    });

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

    await scheduler.scheduledTick(mockContext());

    expect(executePullMock).toHaveBeenCalledWith(expect.anything(), {
      trigger: "scheduled",
    });
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
    expect(failure.message).not.toMatch(/ghp_/);
    expect(options).toMatchObject({
      title: "GitHub token not configured. Configure your token to sync.",
    });
  });

  it("does not call showSyncFailureWithDebug when scheduled pull mock returns false", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull",
    });
    executePullMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(executePullMock).toHaveBeenCalledWith(expect.anything(), {
      trigger: "scheduled",
    });
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when scheduled push mock returns false", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "push",
    });
    executePushMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when scheduled pull-push pull mock fails", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull-push",
    });
    executePullMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(executePushMock).not.toHaveBeenCalled();
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when scheduled pull-push push mock fails", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull-push",
    });
    executePullMock.mockResolvedValue(true);
    executePushMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("calls showSyncFailureWithDebug when scheduledTick catches", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockRejectedValue(
      new Error("tick exception")
    );

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "scheduler",
      trigger: "scheduled",
      message: "tick exception",
    });
    expect(options).toMatchObject({
      title: "Scheduled sync failed: tick exception",
    });
  });

  it("does not call showSyncFailureWithDebug when already in sync", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "none",
    });

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when sync is in progress", async () => {
    isPushLockedMock.mockReturnValue(true);

    const scheduler = await import("../src/scheduler.js");
    const determineSpy = vi.spyOn(
      scheduler.scheduledSyncActionResolver,
      "determineSyncAction"
    );

    await scheduler.scheduledTick(mockContext());

    expect(determineSpy).not.toHaveBeenCalled();
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });
});
