import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshSidebarMock = vi.hoisted(() => vi.fn());
const updateStatusBarMock = vi.hoisted(() => vi.fn());

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: refreshSidebarMock,
}));

vi.mock("../src/statusbar.js", () => ({
  updateStatusBar: updateStatusBarMock,
}));

vi.mock("../src/auth.js", () => ({
  clearToken: vi.fn(async () => {}),
}));

vi.mock("../src/diagnostics.js", () => ({
  clearSyncState: vi.fn(async () => {}),
}));

vi.mock("../src/extensions.js", () => ({
  clearLastRemoteExtensions: vi.fn(async () => {}),
}));

vi.mock("../src/sync-clone.js", () => ({
  removeSyncClone: vi.fn(async () => {}),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      update: async () => {},
    }),
  },
  window: {
    showWarningMessage: async () => "Reset",
    showInformationMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(async () => {}),
  },
  ConfigurationTarget: { Global: 1 },
}));

describe("executeReset", () => {
  beforeEach(() => {
    vi.resetModules();
    refreshSidebarMock.mockReset();
    updateStatusBarMock.mockReset();
  });

  it("releases a stuck sync lock before reset", async () => {
    const syncLock = await import("../src/sync-lock.js");
    expect(syncLock.enterSyncLock()).toMatchObject({ kind: "acquired" });
    expect(syncLock.isSyncLocked()).toBe(true);

    const { executeReset } = await import("../src/reset.js");
    await executeReset({ globalState: { get: () => undefined, update: async () => {} } } as never);

    expect(syncLock.isSyncLocked()).toBe(false);
    expect(refreshSidebarMock).toHaveBeenCalled();
  });

  it("does not drop a lock taken while a cancelled sync is still draining", async () => {
    const syncLock = await import("../src/sync-lock.js");
    const abort = await import("../src/sync-abort.js");
    const hold = syncLock.enterSyncLock();
    expect(hold).toMatchObject({ kind: "acquired" });
    abort.beginSyncAbort();

    const { executeReset } = await import("../src/reset.js");
    const pending = executeReset({
      globalState: { get: () => undefined, update: async () => {} },
    } as never);

    const deadline = Date.now() + 2000;
    let next: ReturnType<typeof syncLock.enterSyncLock> = "busy";
    while (Date.now() < deadline) {
      next = syncLock.enterSyncLock();
      if (next !== "busy") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(next).toMatchObject({ kind: "acquired" });
    abort.endSyncAbort();
    await pending;

    if (hold !== "busy") {
      syncLock.leaveSyncLock(hold);
    }
    expect(syncLock.isSyncLocked()).toBe(true);
    if (next !== "busy") {
      syncLock.leaveSyncLock(next);
    }
    expect(syncLock.isSyncLocked()).toBe(false);
    expect(abort.getSyncAbortSignal()).toBeUndefined();
  });
});
