/**
 * Single-flight lock for push, pull, Sync Now, and scheduled ticks.
 * Nested calls (Sync Now → executePush) pass skipLock after the outer acquire.
 */

let locked = false;

export function isSyncLocked(): boolean {
  return locked;
}

export function tryAcquireSyncLock(): boolean {
  if (locked) {
    return false;
  }
  locked = true;
  return true;
}

export function releaseSyncLock(): void {
  locked = false;
}

export type SyncLockHold = "acquired" | "nested";

export function enterSyncLock(options?: { skipLock?: boolean }): SyncLockHold | "busy" {
  if (options?.skipLock && locked) {
    return "nested";
  }
  if (!tryAcquireSyncLock()) {
    return "busy";
  }
  return "acquired";
}

export function leaveSyncLock(hold: SyncLockHold): void {
  if (hold === "acquired") {
    releaseSyncLock();
  }
}

export function __resetSyncLockForTests(): void {
  locked = false;
}
