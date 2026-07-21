import * as vscode from "vscode";

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
}

let emitterInstance: vscode.EventEmitter<SyncProgressEvent> | undefined;
let busyDepth = 0;

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
export function createSidebarSyncProgress(
  operation: SyncProgressOperation
): vscode.Progress<{ message?: string; increment?: number }> & {
  complete: (ok: boolean) => void;
} {
  let percent = 4;
  let held = false;

  const ensureHeld = () => {
    if (!held) {
      held = true;
      busyDepth += 1;
    }
  };

  return {
    report({ message, increment }) {
      ensureHeld();
      if (typeof increment === "number" && increment > 0) {
        percent = Math.min(99, percent + increment);
      } else if (message) {
        percent = Math.min(95, percent + 6);
      }
      emitSyncProgress({
        operation,
        message: message ?? "",
        percent,
        busy: true,
        done: false,
      });
    },
    complete(ok: boolean) {
      ensureHeld();
      if (held) {
        busyDepth = Math.max(0, busyDepth - 1);
        held = false;
      }
      const stillBusy = busyDepth > 0;
      emitSyncProgress({
        operation,
        message: ok ? "Done" : "Failed",
        percent: stillBusy ? percent : 100,
        done: !stillBusy,
        busy: stillBusy,
        ok,
      });
    },
  };
}
