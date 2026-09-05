import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  enterSyncLock,
  isSyncLocked,
  leaveSyncLock,
  __resetSyncLockForTests,
} from "../src/sync-lock.js";

describe("sync-lock", () => {
  afterEach(() => {
    __resetSyncLockForTests();
  });

  it("refuses a second acquire until released", () => {
    expect(enterSyncLock()).toBe("acquired");
    expect(isSyncLocked()).toBe(true);
    expect(enterSyncLock()).toBe("busy");
    leaveSyncLock("acquired");
    expect(isSyncLocked()).toBe(false);
    expect(enterSyncLock()).toBe("acquired");
  });

  it("skipLock nests when already held and acquires when not", () => {
    expect(enterSyncLock({ skipLock: true })).toBe("acquired");
    expect(enterSyncLock({ skipLock: true })).toBe("nested");
    leaveSyncLock("nested");
    expect(isSyncLocked()).toBe(true);
    leaveSyncLock("acquired");
    expect(isSyncLocked()).toBe(false);
  });
});
