import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEventMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("../src/analytics.js", () => ({
  sendEvent: sendEventMock,
}));

vi.mock("../src/conflict-panel.js", () => ({
  getPendingConflictCount: vi.fn(() => 0),
}));

vi.mock("../src/refresh-sync-status.js", () => ({
  executeRefreshSyncStatus: vi.fn(async () => {}),
}));

function mockContext(): import("vscode").ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-stale-latch" },
    globalState: {
      get: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockReturnValue([]),
    },
    secrets: {
      get: async () => "ghp_test",
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

describe("scheduledTick stale sync latch", () => {
  beforeEach(async () => {
    vi.resetModules();
    sendEventMock.mockReset();
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.intervalMin") return 30;
        return undefined;
      },
      inspect: () => undefined,
      update: vi.fn(),
    } as never);
  });

  afterEach(async () => {
    const { __resetSyncLockForTests } = await import("../src/sync-lock.js");
    __resetSyncLockForTests();
  });

  it("does not treat a stale latch as in-progress skip", async () => {
    const syncLock = await import("../src/sync-lock.js");
    expect(syncLock.enterSyncLock()).toMatchObject({ kind: "acquired" });
    syncLock.__setSyncLockStartedAtForTests(Date.now() - syncLock.STALE_SYNC_LOCK_MS - 1);

    const scheduler = await import("../src/scheduler.js");
    scheduler.scheduledSyncActionResolver.determineSyncAction = vi
      .fn()
      .mockResolvedValue({ action: "none" });

    await scheduler.scheduledTick(mockContext());

    const inProgressSkips = sendEventMock.mock.calls.filter(
      (call) => call[1] === "scheduled_sync_skipped" && call[2]?.reason === "in_progress"
    );
    expect(inProgressSkips).toHaveLength(0);
    expect(syncLock.isSyncLocked()).toBe(false);
  });
});
