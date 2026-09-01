import "./remote-backend-harness.js";
import { describe, it, expect } from "vitest";

import {
  applyRepoSettingsToSyncState,
  normalizeBasePath,
  parseOwnerRepo,
  DEFAULT_REPO_BASE_PATH,
} from "../src/remote/index.js";
import { joinRemotePath, stripRemotePath } from "../src/remote/path-map.js";
import type { SyncState } from "../src/types.js";
import {
  MIN_INTERVAL_SECONDS,
  resolveScheduleInterval,
} from "../src/schedule-interval.js";

describe("parseOwnerRepo", () => {
  it("parses owner/name", () => {
    expect(parseOwnerRepo("acme/cursor-backup")).toEqual({
      owner: "acme",
      repo: "cursor-backup",
    });
  });

  it("parses github URL", () => {
    expect(parseOwnerRepo("https://github.com/acme/cursor-backup.git")).toEqual({
      owner: "acme",
      repo: "cursor-backup",
    });
  });

  it("rejects invalid", () => {
    expect(parseOwnerRepo("only-one")).toBeUndefined();
  });
});

describe("path-map", () => {
  it("joins and strips base path", () => {
    expect(joinRemotePath("cursor-sync", "manifest.json")).toBe("cursor-sync/manifest.json");
    expect(stripRemotePath("cursor-sync", "cursor-sync/manifest.json")).toBe("manifest.json");
    expect(stripRemotePath("cursor-sync", "other/file.json")).toBeUndefined();
  });
});

describe("applyRepoSettingsToSyncState", () => {
  it("replaces saved basePath with current settings path", () => {
    const state: SyncState = {
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "",
      destination: {
        type: "repo",
        owner: "acme",
        repo: "backup",
        branch: "main",
        basePath: "old-path",
      },
      localChecksums: { a: "1" },
      remoteChecksums: { a: "1" },
    };
    const next = applyRepoSettingsToSyncState(state, {
      type: "repo",
      repo: "acme/backup",
      branch: "main",
      path: "new-path",
    });
    expect(next?.destination).toEqual({
      type: "repo",
      owner: "acme",
      repo: "backup",
      branch: "main",
      basePath: "new-path",
      gistId: undefined,
    });
    expect(next?.localChecksums).toEqual({ a: "1" });
  });

  it("returns undefined when there is no sync state yet", () => {
    expect(
      applyRepoSettingsToSyncState(undefined, {
        type: "repo",
        repo: "acme/backup",
        branch: "main",
        path: "cursor-sync",
      })
    ).toBeUndefined();
  });
});

describe("normalizeBasePath", () => {
  it("strips slashes and falls back to default", () => {
    expect(normalizeBasePath(" /foo/bar/ ")).toBe("foo/bar");
    expect(normalizeBasePath("")).toBe(DEFAULT_REPO_BASE_PATH);
  });
});

describe("resolveScheduleInterval", () => {
  it("clamps seconds below minimum", () => {
    const resolved = resolveScheduleInterval({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.interval") return 5;
        if (key === "schedule.intervalUnit") return "seconds";
        return undefined;
      },
      inspect: (key: string) =>
        key === "schedule.interval" ? { globalValue: 5 } : undefined,
    } as never);
    expect(resolved.intervalSeconds).toBe(MIN_INTERVAL_SECONDS);
  });

  it("uses minutes unit", () => {
    const resolved = resolveScheduleInterval({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.interval") return 10;
        if (key === "schedule.intervalUnit") return "minutes";
        return undefined;
      },
      inspect: (key: string) =>
        key === "schedule.interval" ? { globalValue: 10 } : undefined,
    } as never);
    expect(resolved.intervalSeconds).toBe(600);
    expect(resolved.intervalMs).toBe(600_000);
  });

  it("falls back to deprecated intervalMin", () => {
    const resolved = resolveScheduleInterval({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.intervalMin") return 15;
        if (key === "schedule.intervalUnit") return "seconds";
        return undefined;
      },
      inspect: () => undefined,
    } as never);
    expect(resolved.unit).toBe("minutes");
    expect(resolved.intervalSeconds).toBe(15 * 60);
  });
});
