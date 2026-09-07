import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const executePushMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const executePullMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const determineSyncActionMock = vi.hoisted(() => vi.fn());
const showSyncFailureWithDebugMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);
const promptAndInstallMissingExtensionsMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

vi.mock("../src/push.js", () => ({
  executePush: executePushMock,
}));

vi.mock("../src/pull.js", () => ({
  executePull: executePullMock,
}));

vi.mock("../src/scheduler.js", () => ({
  determineSyncAction: determineSyncActionMock,
}));

vi.mock("../src/sync-debug.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-debug.js")>();
  return {
    ...actual,
    showSyncFailureWithDebug: showSyncFailureWithDebugMock,
  };
});

vi.mock("../src/extensions.js", () => ({
  promptAndInstallMissingExtensions: promptAndInstallMissingExtensionsMock,
  readLastRemoteExtensions: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
    getLogger: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
  };
});

import { executeSyncNow } from "../src/sync-now.js";
import { __resetSyncLockForTests } from "../src/sync-lock.js";
import { disposeSyncProgress } from "../src/sync-progress-events.js";
import { endSyncAbort, getSyncAbortSignal } from "../src/sync-abort.js";

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

describe("executeSyncNow", () => {
  beforeEach(() => {
    __resetSyncLockForTests();
    executePullMock.mockReset().mockResolvedValue(true);
    executePushMock.mockReset().mockResolvedValue(true);
    determineSyncActionMock.mockReset();
    showSyncFailureWithDebugMock.mockReset().mockResolvedValue(undefined);
    promptAndInstallMissingExtensionsMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    disposeSyncProgress();
    __resetSyncLockForTests();
    while (getSyncAbortSignal()) {
      endSyncAbort();
    }
  });

  it("pulls then pushes when leftover local changes remain", async () => {
    determineSyncActionMock
      .mockResolvedValueOnce({ action: "pull" })
      .mockResolvedValueOnce({ action: "push" });
    await executeSyncNow(mockContext());
    expect(executePullMock).toHaveBeenCalledTimes(1);
    expect(executePushMock).toHaveBeenCalledTimes(1);
    expect(executePushMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipLock: true, trigger: "syncNow" })
    );
  });

  it("does not push when pull leaves the machine aligned", async () => {
    determineSyncActionMock
      .mockResolvedValueOnce({ action: "pull" })
      .mockResolvedValueOnce({ action: "none" });
    await executeSyncNow(mockContext());
    expect(executePullMock).toHaveBeenCalledTimes(1);
    expect(executePushMock).not.toHaveBeenCalled();
  });

  it("does not push when pull fails", async () => {
    determineSyncActionMock.mockResolvedValue({ action: "pull" });
    executePullMock.mockResolvedValue(false);
    await executeSyncNow(mockContext());
    expect(executePushMock).not.toHaveBeenCalled();
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("pushes only when origin is not ahead", async () => {
    determineSyncActionMock.mockResolvedValue({ action: "push" });
    await executeSyncNow(mockContext());
    expect(executePullMock).not.toHaveBeenCalled();
    expect(executePushMock).toHaveBeenCalledTimes(1);
  });

  it("does not pull a second time if follow-up is still pull", async () => {
    determineSyncActionMock
      .mockResolvedValueOnce({ action: "pull" })
      .mockResolvedValueOnce({ action: "pull" });
    await executeSyncNow(mockContext());
    expect(executePullMock).toHaveBeenCalledTimes(1);
    expect(executePushMock).not.toHaveBeenCalled();
  });
});
