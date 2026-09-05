import * as vscode from "vscode";
import { formatElapsedMs } from "./elapsed.js";

export type SyncProgressOperation = "push" | "pull" | "syncNow";

export interface SyncProgressEvent {
  operation: SyncProgressOperation;
  message: string;
  /** Approximate 0–100 progress; omit for indeterminate. */
  percent?: number;
  done?: boolean;
  ok?: boolean;
  /** When false, sync action buttons should stay disabled (nested ops). */
  busy?: boolean;
  /** Milliseconds since this reporter started. */
  elapsedMs?: number;
  /** Compact label for the sidebar (`12s`, `1m 08s`). */
  elapsedLabel?: string;
}

let emitterInstance: vscode.EventEmitter<SyncProgressEvent> | undefined;
let busyDepth = 0;
const tickTimers = new Set<ReturnType<typeof setInterval>>();
/** Innermost reporter is last; only that one emits elapsed ticks. */
const liveReporters: object[] = [];

function getEmitter(): vscode.EventEmitter<SyncProgressEvent> {
  if (!emitterInstance) {
    emitterInstance = new vscode.EventEmitter<SyncProgressEvent>();
  }
  return emitterInstance;
}

export const onSyncProgress: vscode.Event<SyncProgressEvent> = (
  listener,
  thisArgs,
  disposables
) => getEmitter().event(listener, thisArgs, disposables);

export function emitSyncProgress(event: SyncProgressEvent): void {
  getEmitter().fire(event);
}

export function disposeSyncProgress(): void {
  for (const timer of tickTimers) {
    clearInterval(timer);
  }
  tickTimers.clear();
  liveReporters.length = 0;
  emitterInstance?.dispose();
  emitterInstance = undefined;
  busyDepth = 0;
}

/** Re-enable sidebar sync buttons when no nested sync progress is active. */
export function emitSyncActionsIdle(): void {
  if (busyDepth > 0) {
    return;
  }
  emitSyncProgress({
    operation: "push",
    message: "",
    percent: 100,
    done: true,
    busy: false,
  });
}

/**
 * Progress reporter that mirrors messages into the Sync sidebar
 * (below history) instead of relying on IDE notification toasts.
 * Nested reporters (e.g. Sync Now → Pull → Push) keep buttons locked
 * until the outermost `complete` runs.
 */
export interface SyncProgressReport {
  message?: string;
  increment?: number;
  /** Absolute 0–100. When set, skip the +6-per-message bump. */
  percent?: number;
}

export function createSidebarSyncProgress(
  operation: SyncProgressOperation
): vscode.Progress<SyncProgressReport> & {
  complete: (ok: boolean) => void;
  readonly percent: number;
} {
  let percent = 4;
  let held = false;
  let finished = false;
  let lastMessage = "";
  const startedAt = Date.now();
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  const self = {};

  const elapsedFields = (): { elapsedMs: number; elapsedLabel: string } => {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    return { elapsedMs, elapsedLabel: formatElapsedMs(elapsedMs) };
  };

  const isInnermost = (): boolean =>
    liveReporters[liveReporters.length - 1] === self;

  const stopTick = () => {
    if (tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimers.delete(tickTimer);
      tickTimer = undefined;
    }
  };

  const emitBusy = (message: string, nextPercent: number) => {
    emitSyncProgress({
      operation,
      message,
      percent: nextPercent,
      busy: true,
      done: false,
      ...elapsedFields(),
    });
  };

  const ensureHeld = () => {
    if (!held) {
      held = true;
      busyDepth += 1;
      liveReporters.push(self);
      tickTimer = setInterval(() => {
        if (!isInnermost()) {
          return;
        }
        emitBusy(lastMessage, percent);
      }, 1000);
      tickTimers.add(tickTimer);
    }
  };

  const releaseHeld = () => {
    if (!held) {
      return;
    }
    const idx = liveReporters.lastIndexOf(self);
    if (idx >= 0) {
      liveReporters.splice(idx, 1);
    }
    busyDepth = Math.max(0, busyDepth - 1);
    held = false;
  };

  return {
    get percent() {
      return percent;
    },
    report({ message, increment, percent: absolutePercent }) {
      ensureHeld();
      if (typeof absolutePercent === "number" && Number.isFinite(absolutePercent)) {
        percent = Math.min(95, Math.max(0, absolutePercent));
      } else if (typeof increment === "number" && increment > 0) {
        percent = Math.min(99, percent + increment);
      } else if (message) {
        percent = Math.min(95, percent + 6);
      }
      if (message) {
        lastMessage = message;
      }
      emitBusy(lastMessage, percent);
    },
    complete(ok: boolean) {
      if (finished) {
        return;
      }
      finished = true;
      ensureHeld();
      stopTick();
      releaseHeld();
      const stillBusy = busyDepth > 0;
      if (stillBusy && ok) {
        // Nested success: keep the inner phase text (e.g. Fetching n/m)
        // instead of flashing Done / the parent's Pulling… tick.
        return;
      }
      emitSyncProgress({
        operation,
        message: ok ? "Done" : "Failed",
        percent: stillBusy ? percent : 100,
        done: !stillBusy,
        busy: stillBusy,
        ok,
        ...elapsedFields(),
      });
    },
  };
}
