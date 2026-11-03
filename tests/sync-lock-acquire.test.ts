import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const refreshMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/refresh-sync-status.js", () => ({
  executeRefreshSyncStatus: refreshMock,
}));

import {
  STALE_SYNC_LOCK_MS,
  __resetSyncLockForTests,
  __setSyncLockStartedAtForTests,
  enterSyncLock,
} from "../src/sync-lock.js";
import { beginSyncAbort, endSyncAbort, getSyncAbortSignal } from "../src/sync-abort.js";

const context = {} as import("vscode").ExtensionContext;

describe("acquireSyncOperationLock", () => {
  afterEach(() => {
    while (getSyncAbortSignal()) {
      endSyncAbort();
    }
    __resetSyncLockForTests();
    refreshMock.mockClear();
  });

  it("recovers a stale latch and acquires again", async () => {
    expect(enterSyncLock()).toMatchObject({ kind: "acquired" });
    __setSyncLockStartedAtForTests(Date.now() - STALE_SYNC_LOCK_MS - 1);

    const { acquireSyncOperationLock } = await import("../src/sync-lock-acquire.js");
    const hold = await acquireSyncOperationLock(context);
    expect(hold).toMatchObject({ kind: "acquired" });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("refuses forceRecover while a sync abort scope is active", async () => {
    expect(enterSyncLock()).toMatchObject({ kind: "acquired" });
    beginSyncAbort();

    const { acquireSyncOperationLock } = await import("../src/sync-lock-acquire.js");
    const hold = await acquireSyncOperationLock(context, { forceRecover: true });
    expect(hold).toBe("busy");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("force-clears latch when busy and no sync is running", async () => {
    expect(enterSyncLock()).toMatchObject({ kind: "acquired" });

    const { acquireSyncOperationLock } = await import("../src/sync-lock-acquire.js");
    const hold = await acquireSyncOperationLock(context, { forceRecover: true });
    expect(hold).toMatchObject({ kind: "acquired" });
    expect(refreshMock).toHaveBeenCalled();
  });
});
