/**
 * Single-flight lock for push, pull, Sync Now, and scheduled ticks.
 * Nested calls (Sync Now → executePush) pass skipLock after the outer acquire.
 */

export const STALE_SYNC_LOCK_MS = 10 * 60 * 1000;

let locked = false;
let lockedAt: number | undefined;
let lockGeneration = 0;

export function isSyncLocked(): boolean {
  return locked;
}

export function isSyncLockStale(nowMs = Date.now()): boolean {
  return (
    locked &&
    lockedAt !== undefined &&
    nowMs - lockedAt > STALE_SYNC_LOCK_MS
  );
}

/** Drops the latch and invalidates every hold acquired before this call. */
export function resetSyncLock(): number {
  lockGeneration += 1;
  locked = false;
  lockedAt = undefined;
  return lockGeneration;
}

/** Clears the latch only when nobody has acquired a newer hold since `generation`. */
export function releaseSyncLockIfGeneration(generation: number): void {
  if (lockGeneration !== generation) {
    return;
  }
  locked = false;
  lockedAt = undefined;
}

/** Clears the latch only when it has been held longer than {@link STALE_SYNC_LOCK_MS}. */
export function recoverStaleSyncLockOnly(): boolean {
  if (isSyncLockStale()) {
    resetSyncLock();
    return true;
  }
  return false;
}

export function tryAcquireSyncLock(): boolean {
  if (locked) {
    return false;
  }
  locked = true;
  lockedAt = Date.now();
  return true;
}

export type AcquiredSyncLock = { readonly kind: "acquired"; readonly generation: number };
export type SyncLockHold = AcquiredSyncLock | "nested";

export function enterSyncLock(options?: { skipLock?: boolean }): SyncLockHold | "busy" {
  if (options?.skipLock && locked) {
    return "nested";
  }
  if (!tryAcquireSyncLock()) {
    return "busy";
  }
  lockGeneration += 1;
  return { kind: "acquired", generation: lockGeneration };
}

export function leaveSyncLock(hold: SyncLockHold): void {
  if (hold === "nested" || hold.generation !== lockGeneration) {
    return;
  }
  locked = false;
  lockedAt = undefined;
}

export function __resetSyncLockForTests(): void {
  resetSyncLock();
}

export function __setSyncLockStartedAtForTests(startedAt: number | undefined): void {
  lockedAt = startedAt;
}
