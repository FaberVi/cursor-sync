import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  createSidebarSyncProgress,
  disposeSyncProgress,
  onSyncProgress,
  type SyncProgressEvent,
} from "../src/sync-progress-events.js";

describe("createSidebarSyncProgress elapsed", () => {
  afterEach(() => {
    disposeSyncProgress();
    vi.useRealTimers();
  });

  it("includes elapsed on each event and ticks once per second while busy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));

    const events: SyncProgressEvent[] = [];
    const sub = onSyncProgress((event) => events.push(event));
    const reporter = createSidebarSyncProgress("pull");
    try {
      reporter.report({ message: "Fetching remote manifest…" });
      expect(events.at(-1)?.elapsedLabel).toBe("0s");
      expect(events.at(-1)?.elapsedMs).toBe(0);

      vi.advanceTimersByTime(1000);
      expect(events.at(-1)?.elapsedLabel).toBe("1s");
      expect(events.at(-1)?.message).toBe("Fetching remote manifest…");

      vi.advanceTimersByTime(1000);
      expect(events.at(-1)?.elapsedLabel).toBe("2s");

      const countBeforeComplete = events.length;
      reporter.complete(true);
      expect(events.at(-1)?.done).toBe(true);
      expect(events.at(-1)?.elapsedLabel).toBe("2s");

      vi.advanceTimersByTime(3000);
      expect(events.length).toBe(countBeforeComplete + 1);
    } finally {
      reporter.complete(true);
      sub.dispose();
    }
  });

  it("nested pull does not swap the elapsed tick back to Pulling…", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));

    const events: SyncProgressEvent[] = [];
    const sub = onSyncProgress((event) => events.push(event));
    const outer = createSidebarSyncProgress("syncNow");
    const inner = createSidebarSyncProgress("pull");
    try {
      outer.report({ message: "Pulling…" });
      inner.report({
        message: "Fetching 100/250 changed file(s)…",
        percent: 40,
      });

      const afterFetch = events.length;
      vi.advanceTimersByTime(3000);
      const duringFetch = events.slice(afterFetch);
      expect(duringFetch.length).toBeGreaterThan(0);
      expect(duringFetch.every((e) => e.message !== "Pulling…")).toBe(true);
      expect(events.at(-1)?.message).toBe("Fetching 100/250 changed file(s)…");
      expect(events.at(-1)?.operation).toBe("pull");
    } finally {
      inner.complete(true);
      outer.complete(true);
      sub.dispose();
    }
  });

  it("stops the inner reporter tick without leaving nested Sync Now busy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));

    const events: SyncProgressEvent[] = [];
    const sub = onSyncProgress((event) => events.push(event));
    const outer = createSidebarSyncProgress("syncNow");
    const inner = createSidebarSyncProgress("pull");
    try {
      outer.report({ message: "Starting sync…" });
      inner.report({ message: "Fetching remote manifest…" });
      inner.complete(true);

      const afterInner = events.length;
      vi.advanceTimersByTime(1000);
      expect(events.length).toBeGreaterThan(afterInner);
      expect(events.at(-1)?.operation).toBe("syncNow");
      expect(events.at(-1)?.busy).toBe(true);

      outer.complete(true);
      const afterOuter = events.length;
      vi.advanceTimersByTime(2000);
      expect(events.length).toBe(afterOuter);
    } finally {
      inner.complete(true);
      outer.complete(true);
      sub.dispose();
    }
  });

  it("uses an absolute percent without the +6 message bump", () => {
    const events: SyncProgressEvent[] = [];
    const sub = onSyncProgress((event) => events.push(event));
    const reporter = createSidebarSyncProgress("push");
    try {
      reporter.report({ message: "Packaging local files…" });
      const afterMessage = events.at(-1)?.percent;
      expect(afterMessage).toBe(10);

      reporter.report({
        message: "Uploading 2/10 changed file(s)…",
        percent: 40,
      });
      expect(events.at(-1)?.percent).toBe(40);
      expect(events.at(-1)?.message).toBe("Uploading 2/10 changed file(s)…");
    } finally {
      reporter.complete(true);
      sub.dispose();
    }
  });
});
