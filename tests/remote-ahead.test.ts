import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const getToken = vi.hoisted(() => vi.fn());
const isRepoDestinationConfigured = vi.hoisted(() => vi.fn());
const isSyncLocked = vi.hoisted(() => vi.fn());
const fetchOrigin = vi.hoisted(() => vi.fn());
const ensureSyncClone = vi.hoisted(() => vi.fn());
const relationToOrigin = vi.hoisted(() => vi.fn());
const getPendingConflictCount = vi.hoisted(() => vi.fn());
const showWarningMessage = vi.hoisted(() => vi.fn());

vi.mock("../src/auth.js", () => ({
  getToken,
}));
vi.mock("../src/remote/destination.js", () => ({
  isRepoDestinationConfigured,
}));
vi.mock("../src/sync-lock.js", () => ({
  isSyncLocked,
}));
vi.mock("../src/conflict-panel.js", () => ({
  getPendingConflictCount,
  revealConflictPanel: vi.fn(),
}));
vi.mock("../src/sync-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-clone.js")>();
  return {
    ...actual,
    fetchOrigin,
    ensureSyncClone,
    relationToOrigin,
    getSyncClonePath: () => "/tmp/sync-repo",
    readRepoIdentity: () => ({
      owner: "o",
      repo: "r",
      branch: "main",
      basePath: "cursor-sync",
    }),
  };
});
vi.mock("../src/git-cli.js", () => ({
  runGit: vi.fn(async ({ args }: { args: string[] }) => {
    if (args[0] === "rev-list") {
      return { stdout: "2", stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse") {
      return { stdout: "abc", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(async () => ({ isDirectory: () => true, isFile: () => false })),
  };
});

import * as vscode from "vscode";
import * as statusbar from "../src/statusbar.js";
import {
  __resetRemoteAheadForTests,
  getRemoteAheadCache,
  maybeToastRemoteAhead,
  probeRemoteAhead,
  recordRemoteRelation,
  syncStatusBarWithRemoteAheadCache,
} from "../src/remote-ahead.js";
import {
  __resetLocalDiffersForTests,
  recordLocalDiffers,
} from "../src/cursor-differs.js";

function context(): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp" },
    secrets: { get: async () => "tok" },
  } as unknown as vscode.ExtensionContext;
}

describe("remote-ahead", () => {
  afterEach(() => {
    __resetRemoteAheadForTests();
    __resetLocalDiffersForTests();
    vi.clearAllMocks();
  });

  it("skips probe when unconfigured", async () => {
    isRepoDestinationConfigured.mockReturnValue(false);
    await probeRemoteAhead(context());
    expect(fetchOrigin).not.toHaveBeenCalled();
    expect(getRemoteAheadCache()).toBeUndefined();
  });

  it("skips probe when there is no token", async () => {
    isRepoDestinationConfigured.mockReturnValue(true);
    isSyncLocked.mockReturnValue(false);
    getPendingConflictCount.mockReturnValue(0);
    getToken.mockResolvedValue(undefined);
    await probeRemoteAhead(context());
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("skips probe when sync is locked", async () => {
    isRepoDestinationConfigured.mockReturnValue(true);
    isSyncLocked.mockReturnValue(true);
    await probeRemoteAhead(context());
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("records cache after a successful fetch", async () => {
    isRepoDestinationConfigured.mockReturnValue(true);
    isSyncLocked.mockReturnValue(false);
    getPendingConflictCount.mockReturnValue(0);
    getToken.mockResolvedValue("tok");
    fetchOrigin.mockResolvedValue(undefined);
    relationToOrigin.mockResolvedValue("behind");
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    await probeRemoteAhead(context());
    expect(getRemoteAheadCache()?.relation).toBe("behind");
    expect(getRemoteAheadCache()?.behindCount).toBe(2);
  });

  it("toasts only once per behind episode", async () => {
    recordRemoteRelation({ relation: "behind", behindCount: 1 });
    isSyncLocked.mockReturnValue(false);
    const spy = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue(undefined);
    await maybeToastRemoteAhead();
    await maybeToastRemoteAhead();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("toasts again when behind becomes diverged", async () => {
    isSyncLocked.mockReturnValue(false);
    const spy = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue(undefined);
    recordRemoteRelation({ relation: "behind", behindCount: 1 });
    await maybeToastRemoteAhead();
    recordRemoteRelation({ relation: "diverged" });
    await maybeToastRemoteAhead();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[1]).toBe("Reset to remote");
  });
});

describe("syncStatusBarWithRemoteAheadCache", () => {
  afterEach(() => {
    __resetRemoteAheadForTests();
    __resetLocalDiffersForTests();
    vi.restoreAllMocks();
  });

  it("does not set OK when the clone is ahead of origin", () => {
    vi.spyOn(statusbar, "getStatusBarState").mockReturnValue("ok");
    const spy = vi.spyOn(statusbar, "updateStatusBar");
    recordLocalDiffers(false);
    recordRemoteRelation({ relation: "ahead" });
    expect(spy).toHaveBeenCalledWith("not-synced", undefined);
  });

  it("does not set OK when local files differ", () => {
    vi.spyOn(statusbar, "getStatusBarState").mockReturnValue("ok");
    const spy = vi.spyOn(statusbar, "updateStatusBar");
    recordLocalDiffers(true);
    recordRemoteRelation({ relation: "equal" });
    expect(spy).toHaveBeenCalledWith("not-synced", undefined);
  });

  it("sets OK when equal and local hashes match", () => {
    vi.spyOn(statusbar, "getStatusBarState").mockReturnValue("ok");
    const spy = vi.spyOn(statusbar, "updateStatusBar");
    recordLocalDiffers(false);
    recordRemoteRelation({ relation: "equal" });
    expect(spy).toHaveBeenCalledWith("ok", undefined);
  });

  it("keeps behind presentation when origin is ahead", () => {
    vi.spyOn(statusbar, "getStatusBarState").mockReturnValue("ok");
    const spy = vi.spyOn(statusbar, "updateStatusBar");
    recordLocalDiffers(true);
    recordRemoteRelation({ relation: "behind", behindCount: 1 });
    expect(spy.mock.calls.at(-1)?.[0]).toBe("behind");
  });

  it("skips updates while syncing unless includeSyncing is set", () => {
    vi.spyOn(statusbar, "getStatusBarState").mockReturnValue("syncing");
    const spy = vi.spyOn(statusbar, "updateStatusBar");
    recordLocalDiffers(false);
    recordRemoteRelation({ relation: "equal" });
    expect(spy).not.toHaveBeenCalled();
    syncStatusBarWithRemoteAheadCache(undefined, { includeSyncing: true });
    expect(spy).toHaveBeenCalledWith("ok", undefined);
  });
});
