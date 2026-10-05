import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  STALE_SYNC_LOCK_MS,
  enterSyncLock,
  isSyncLocked,
  isSyncLockStale,
  leaveSyncLock,
  recoverStaleSyncLockOnly,
  resetSyncLock,
  __resetSyncLockForTests,
  __setSyncLockStartedAtForTests,
  type SyncLockHold,
} from "../src/sync-lock.js";

function acquiredHold(): SyncLockHold {
  const hold = enterSyncLock();
  expect(hold).toMatchObject({ kind: "acquired" });
  return hold;
}

describe("sync-lock", () => {
  afterEach(() => {
    __resetSyncLockForTests();
  });

  it("refuses a second acquire until released", () => {
    const hold = acquiredHold();
    expect(isSyncLocked()).toBe(true);
    expect(enterSyncLock()).toBe("busy");
    leaveSyncLock(hold);
    expect(isSyncLocked()).toBe(false);
    expect(enterSyncLock()).toMatchObject({ kind: "acquired" });
  });

  it("skipLock nests when already held and acquires when not", () => {
    const hold = enterSyncLock({ skipLock: true });
    expect(hold).toMatchObject({ kind: "acquired" });
    expect(enterSyncLock({ skipLock: true })).toBe("nested");
    leaveSyncLock("nested");
    expect(isSyncLocked()).toBe(true);
    leaveSyncLock(hold);
    expect(isSyncLocked()).toBe(false);
  });

  it("does not treat a fresh lock as stale", () => {
    const hold = acquiredHold();
    expect(isSyncLockStale()).toBe(false);
    expect(recoverStaleSyncLockOnly()).toBe(false);
    leaveSyncLock(hold);
  });

  it("recovers a lock held past the stale threshold", () => {
    const staleHold = acquiredHold();
    const staleAt = Date.now() - STALE_SYNC_LOCK_MS - 1;
    __setSyncLockStartedAtForTests(staleAt);
    expect(isSyncLockStale()).toBe(true);
    expect(recoverStaleSyncLockOnly()).toBe(true);
    expect(isSyncLocked()).toBe(false);
    const next = acquiredHold();
    leaveSyncLock(staleHold);
    expect(isSyncLocked()).toBe(true);
    leaveSyncLock(next);
    expect(isSyncLocked()).toBe(false);
  });

  it("ignores a hold released after the latch was reset", () => {
    const hold = acquiredHold();
    resetSyncLock();
    const next = acquiredHold();
    leaveSyncLock(hold);
    expect(isSyncLocked()).toBe(true);
    leaveSyncLock(next);
    expect(isSyncLocked()).toBe(false);
  });
});
