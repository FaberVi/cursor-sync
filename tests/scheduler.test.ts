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

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("calls showSyncFailureWithDebug on determineSyncAction conflict with warning", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "conflict",
      keys: ["cursor-user/settings.json"],
    });

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "scheduler",
      trigger: "scheduled",
      category: "CONFLICT",
      conflictCount: 1,
      message: "1 conflict(s) detected. Resolve them first.",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({
      level: "warning",
      title: "1 conflict(s) detected. Resolve them first.",
    });
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
