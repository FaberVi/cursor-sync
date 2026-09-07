import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const runGit = vi.hoisted(() => vi.fn());
const readRepoIdentity = vi.hoisted(() => vi.fn());
const getSyncClonePath = vi.hoisted(() => vi.fn());
const hashCursorSyncFiles = vi.hoisted(() => vi.fn());
const hashCloneSyncFiles = vi.hoisted(() => vi.fn());
const isChatSyncEnabled = vi.hoisted(() => vi.fn());
const getRemoteAheadCache = vi.hoisted(() => vi.fn());

vi.mock("../src/git-cli.js", () => ({
  runGit,
}));
vi.mock("../src/sync-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-clone.js")>();
  return {
    ...actual,
    readRepoIdentity,
    getSyncClonePath,
  };
});
vi.mock("../src/sync-copy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-copy.js")>();
  return {
    ...actual,
    hashCursorSyncFiles,
    hashCloneSyncFiles,
  };
});
vi.mock("../src/chat-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-sync.js")>();
  return {
    ...actual,
    isChatSyncEnabled,
  };
});
vi.mock("../src/remote-ahead.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-ahead.js")>();
  return {
    ...actual,
    getRemoteAheadCache,
  };
});

import { isStatusPreviewKind, listStatusPreviewEntries } from "../src/status-preview.js";

function context(): import("vscode").ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/status-preview" },
  } as unknown as import("vscode").ExtensionContext;
}

describe("isStatusPreviewKind", () => {
  it("accepts the four inspectable kinds", () => {
    expect(isStatusPreviewKind("local")).toBe(true);
    expect(isStatusPreviewKind("incoming")).toBe(true);
    expect(isStatusPreviewKind("localOnly")).toBe(true);
    expect(isStatusPreviewKind("diverged")).toBe(true);
    expect(isStatusPreviewKind("nope")).toBe(false);
  });
});

describe("listStatusPreviewEntries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when the repo is not configured", async () => {
    readRepoIdentity.mockReturnValue(undefined);
    expect(await listStatusPreviewEntries(context(), "local")).toEqual([]);
  });

  it("lists local hash diffs", async () => {
    readRepoIdentity.mockReturnValue({
      owner: "o",
      repo: "r",
      branch: "main",
      basePath: "cursor-sync",
    });
    getSyncClonePath.mockReturnValue("/tmp/clone");
    hashCursorSyncFiles.mockResolvedValue({
      "cursor-user/settings.json": "local",
    });
    hashCloneSyncFiles.mockResolvedValue({
      "cursor-user/settings.json": "clone",
    });
    isChatSyncEnabled.mockReturnValue(false);
    expect(await listStatusPreviewEntries(context(), "local")).toEqual([
      { syncKey: "cursor-user/settings.json", change: "modified" },
    ]);
  });

  it("lists local-only keys absent from the clone", async () => {
    readRepoIdentity.mockReturnValue({
      owner: "o",
      repo: "r",
      branch: "main",
      basePath: "cursor-sync",
    });
    getSyncClonePath.mockReturnValue("/tmp/clone");
    hashCursorSyncFiles.mockResolvedValue({
      "dot-cursor/skills/foo/SKILL.md": "x",
      "cursor-user/settings.json": "y",
    });
    hashCloneSyncFiles.mockResolvedValue({
      "cursor-user/settings.json": "y",
    });
    expect(await listStatusPreviewEntries(context(), "localOnly")).toEqual([
      { syncKey: "dot-cursor/skills/foo/SKILL.md", change: "added" },
    ]);
  });

  it("maps incoming git names to sync keys", async () => {
    readRepoIdentity.mockReturnValue({
      owner: "o",
      repo: "r",
      branch: "main",
      basePath: "cursor-sync",
    });
    getSyncClonePath.mockReturnValue("/tmp/clone");
    runGit.mockResolvedValue({
      stdout: "cursor-sync/cursor-user/settings.json\n",
      stderr: "",
      code: 0,
    });
    expect(await listStatusPreviewEntries(context(), "incoming")).toEqual([
      { syncKey: "cursor-user/settings.json", change: "incoming" },
    ]);
    expect(runGit).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["diff", "--name-only", "HEAD...origin/main"],
      })
    );
  });

  it("lists files that differ between HEAD and origin when diverged", async () => {
    readRepoIdentity.mockReturnValue({
      owner: "o",
      repo: "r",
      branch: "main",
      basePath: "cursor-sync",
    });
    getSyncClonePath.mockReturnValue("/tmp/clone");
    runGit.mockResolvedValue({
      stdout: "cursor-sync/cursor-user/keybindings.json\n",
      stderr: "",
      code: 0,
    });
    expect(await listStatusPreviewEntries(context(), "diverged")).toEqual([
      { syncKey: "cursor-user/keybindings.json", change: "modified" },
    ]);
    expect(runGit).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["diff", "--name-only", "HEAD", "origin/main"],
      })
    );
  });
});
