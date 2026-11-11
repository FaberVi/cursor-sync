import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = path.join(os.tmpdir(), `cursor-sync-diff-${process.pid}`);
const userRoot = path.join(root, "user");
const storageRoot = path.join(root, "storage");

const runGit = vi.hoisted(() => vi.fn());
const readRepoIdentity = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({ cursorUser: userRoot, dotCursor: userRoot }),
}));
vi.mock("../src/git-cli.js", () => ({ runGit }));
vi.mock("../src/sync-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-clone.js")>();
  return {
    ...actual,
    readRepoIdentity,
  };
});

import * as vscode from "vscode";
import {
  __resetVscodeCommandsMock,
  __setExecuteCommandImpl,
} from "./__mocks__/vscode.js";
import {
  __resetRemoteSyncKeyCacheForTests,
  openSyncKeyComparison,
  provideRemoteSyncKeyText,
  REMOTE_BLOB_MAX_BYTES,
  REMOTE_SYNC_KEY_SCHEME,
} from "../src/sync-key-diff.js";

const syncKey = "cursor-user/settings.json";

function context(): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: storageRoot },
  } as unknown as vscode.ExtensionContext;
}

function identity(basePath = "cursor-sync") {
  return { owner: "o", repo: "r", branch: "main", basePath };
}

function cloneFile(): string {
  return path.join(storageRoot, "sync-repo", "cursor-sync", "cursor-user", "settings.json");
}

function cursorFile(): string {
  return path.join(userRoot, "settings.json");
}

describe("openSyncKeyComparison", () => {
  const showTextDocument = vi.fn(async () => ({}));
  const commands: unknown[][] = [];

  beforeEach(async () => {
    await fs.mkdir(userRoot, { recursive: true });
    await fs.mkdir(storageRoot, { recursive: true });
    readRepoIdentity.mockReturnValue(identity());
    runGit.mockReset();
    showTextDocument.mockReset();
    commands.length = 0;
    __resetRemoteSyncKeyCacheForTests();
    (vscode.window as { showTextDocument: typeof showTextDocument }).showTextDocument =
      showTextDocument;
    __setExecuteCommandImpl(async (command: string, ...args: unknown[]) => {
      commands.push([command, ...args]);
    });
  });

  afterEach(async () => {
    __resetRemoteSyncKeyCacheForTests();
    __resetVscodeCommandsMock();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("diffs the clone file against the Cursor file for local changes", async () => {
    await fs.mkdir(path.dirname(cursorFile()), { recursive: true });
    await fs.mkdir(path.dirname(cloneFile()), { recursive: true });
    await fs.writeFile(cursorFile(), "local\n", "utf8");
    await fs.writeFile(cloneFile(), "clone\n", "utf8");

    await openSyncKeyComparison(syncKey, context(), "local");

    expect(runGit).not.toHaveBeenCalled();
    expect(showTextDocument).not.toHaveBeenCalled();
    expect(commands).toEqual([
      [
        "vscode.diff",
        expect.objectContaining({ scheme: "file", fsPath: path.resolve(cloneFile()) }),
        expect.objectContaining({ scheme: "file", fsPath: path.resolve(cursorFile()) }),
        "settings.json (Remote ↔ Local)",
        { preview: true, viewColumn: vscode.ViewColumn.One },
      ],
    ]);
  });

  it("opens the only file when the other local side is missing", async () => {
    await fs.mkdir(path.dirname(cursorFile()), { recursive: true });
    await fs.writeFile(cursorFile(), "local\n", "utf8");

    await openSyncKeyComparison(syncKey, context(), "local");

    expect(commands.filter((call) => call[0] === "vscode.diff")).toEqual([]);
    expect(showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: path.resolve(cursorFile()) }),
      expect.objectContaining({ preview: true })
    );
  });

  it.each(["incoming", "diverged"] as const)(
    "diffs %s against the origin blob",
    async (kind) => {
      await fs.mkdir(path.dirname(cursorFile()), { recursive: true });
      await fs.writeFile(cursorFile(), "local\n", "utf8");
      runGit.mockResolvedValue({ stdout: "remote\n", stderr: "", code: 0 });

      await openSyncKeyComparison(syncKey, context(), kind);

      expect(runGit).toHaveBeenCalledWith({
        args: ["show", "origin/main:cursor-sync/cursor-user/settings.json"],
        cwd: path.join(storageRoot, "sync-repo"),
      });
      expect(runGit.mock.calls[0]?.[0]).not.toHaveProperty("pat");
      const diff = commands.find((call) => call[0] === "vscode.diff");
      expect(diff?.[1]).toEqual(
        expect.objectContaining({
          scheme: REMOTE_SYNC_KEY_SCHEME,
          path: `/${syncKey}`,
        })
      );
      expect(diff?.[2]).toEqual(
        expect.objectContaining({ fsPath: path.resolve(cursorFile()) })
      );
      expect(showTextDocument).not.toHaveBeenCalled();
      runGit.mockRejectedValue(new Error("should use the cache"));
      await expect(
        provideRemoteSyncKeyText(diff?.[1] as vscode.Uri, context())
      ).resolves.toBe("remote\n");
    }
  );

  it("uses the clone file as the local side when the Cursor file is absent", async () => {
    await fs.mkdir(path.dirname(cloneFile()), { recursive: true });
    await fs.writeFile(cloneFile(), "head\n", "utf8");
    runGit.mockResolvedValue({ stdout: "remote\n", stderr: "", code: 0 });

    await openSyncKeyComparison(syncKey, context(), "incoming");

    const diff = commands.find((call) => call[0] === "vscode.diff");
    expect(diff?.[1]).toEqual(expect.objectContaining({ scheme: REMOTE_SYNC_KEY_SCHEME }));
    expect(diff?.[2]).toEqual(
      expect.objectContaining({ fsPath: path.resolve(cloneFile()) })
    );
  });

  it.each([
    ["a NUL byte", `ok\0no`],
    ["more than 1 MiB", "x".repeat(REMOTE_BLOB_MAX_BYTES + 1)],
  ])("opens the local file when the origin blob has %s", async (_label, stdout) => {
    await fs.mkdir(path.dirname(cursorFile()), { recursive: true });
    await fs.writeFile(cursorFile(), "local\n", "utf8");
    runGit.mockResolvedValue({ stdout, stderr: "", code: 0 });

    await openSyncKeyComparison(syncKey, context(), "incoming");

    expect(commands.filter((call) => call[0] === "vscode.diff")).toEqual([]);
    expect(commands.some((call) => JSON.stringify(call).includes(REMOTE_SYNC_KEY_SCHEME))).toBe(
      false
    );
    expect(showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: path.resolve(cursorFile()) }),
      expect.anything()
    );
  });

  it("opens a diff when the origin blob is exactly 1 MiB", async () => {
    await fs.mkdir(path.dirname(cursorFile()), { recursive: true });
    await fs.writeFile(cursorFile(), "local\n", "utf8");
    runGit.mockResolvedValue({
      stdout: "y".repeat(REMOTE_BLOB_MAX_BYTES),
      stderr: "",
      code: 0,
    });

    await openSyncKeyComparison(syncKey, context(), "diverged");

    expect(commands.filter((call) => call[0] === "vscode.diff")).toHaveLength(1);
  });

  it("does not call git when the sync key or base path contains ..", async () => {
    await fs.mkdir(path.dirname(cursorFile()), { recursive: true });
    await fs.writeFile(cursorFile(), "local\n", "utf8");

    await openSyncKeyComparison("cursor-user/../../outside.txt", context(), "incoming");
    readRepoIdentity.mockReturnValue(identity(".."));
    await openSyncKeyComparison(syncKey, context(), "diverged");

    expect(runGit).not.toHaveBeenCalled();
    expect(commands.filter((call) => call[0] === "vscode.diff")).toEqual([]);
  });

  it("does not read a remote document whose path climbs out of the repo", async () => {
    await expect(
      provideRemoteSyncKeyText(
        vscode.Uri.from({
          scheme: REMOTE_SYNC_KEY_SCHEME,
          path: "/cursor-user/../../secret",
          query: "ref=origin%2Fmain",
        }),
        context()
      )
    ).rejects.toThrow("Remote copy is missing, binary, or too large.");
    expect(runGit).not.toHaveBeenCalled();
  });

  it("treats a git error as a missing blob and opens the local file", async () => {
    await fs.mkdir(path.dirname(cursorFile()), { recursive: true });
    await fs.writeFile(cursorFile(), "local\n", "utf8");
    runGit.mockRejectedValue(new Error("fatal: path exists on disk, but not in origin"));

    await openSyncKeyComparison(syncKey, context(), "incoming");

    expect(commands.filter((call) => call[0] === "vscode.diff")).toEqual([]);
    expect(showTextDocument).toHaveBeenCalled();
  });
});
