import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as crypto from "node:crypto";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("conflicts", () => {
  const tmpDir = path.join(os.tmpdir(), "cursor-sync-test-conflicts-" + Date.now());
  const storageDir = path.join(tmpDir, "storage");

  function makeContext() {
    const state = new Map<string, unknown>();
    return {
      globalStorageUri: { fsPath: storageDir },
      globalState: {
        get: (key: string) => state.get(key),
        update: async (key: string, value: unknown) => {
          if (value === undefined) {
            state.delete(key);
          } else {
            state.set(key, value);
          }
        },
        keys: () => [...state.keys()],
      },
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        onDidChange: () => ({ dispose: () => {} }),
      },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;
  }

  beforeEach(async () => {
    await fs.mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    vi.resetModules();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("skips mcp.json conflicts when MCP sync is off", async () => {
    const { findConflicts } = await import("../src/conflicts.js");
    const original = "aaa";
    const changed = "bbb";
    const conflicts = findConflicts(
      {
        lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
        lastSyncDirection: "push",
        gistId: "g",
        localChecksums: { "dot-cursor/mcp.json": original },
        remoteChecksums: { "dot-cursor/mcp.json": original },
      },
      { "dot-cursor/mcp.json": changed },
      { "dot-cursor/mcp.json": "ccc" }
    );
    expect(conflicts).toEqual([]);
  });

  it("detects no conflicts when sync state is absent", async () => {
    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();
    const conflicts = await detectConflicts(context, {});
    expect(conflicts).toEqual([]);
  });

  it("detects conflict when both local and remote changed", async () => {
    const cursorUser = path.join(tmpDir, "cursorUser");
    await fs.mkdir(cursorUser, { recursive: true });

    const originalContent = "original";
    const localContent = "local-changed";
    const remoteContent = "remote-changed";

    await fs.writeFile(path.join(cursorUser, "settings.json"), localContent);

    const syncState = {
      lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
      lastSyncDirection: "push" as const,
      gistId: "test-gist",
      localChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
      remoteChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
    };

    await fs.mkdir(storageDir, { recursive: true });
    await fs.writeFile(
      path.join(storageDir, "sync-state.json"),
      JSON.stringify(syncState)
    );

    vi.doMock("../src/paths.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/paths.js")>();
      return {
        ...original,
        resolveSyncRoots: () => ({
          cursorUser,
          dotCursor: path.join(tmpDir, "dotCursor"),
        }),
        enumerateSyncFiles: async () => [
          {
            absolutePath: path.join(cursorUser, "settings.json"),
            relativeSyncKey: "cursor-user/settings.json",
          },
        ],
      };
    });

    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();

    const remoteChecksums = {
      "cursor-user/settings.json": sha256(remoteContent),
    };

    const conflicts = await detectConflicts(context, remoteChecksums);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].relativeSyncKey).toBe("cursor-user/settings.json");
  });

  it("detects no conflict when only local changed", async () => {
    const cursorUser = path.join(tmpDir, "cursorUser");
    await fs.mkdir(cursorUser, { recursive: true });

    const originalContent = "original";
    const localContent = "local-changed";

    await fs.writeFile(path.join(cursorUser, "settings.json"), localContent);

    const syncState = {
      lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
      lastSyncDirection: "push" as const,
      gistId: "test-gist",
      localChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
      remoteChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
    };

    await fs.writeFile(
      path.join(storageDir, "sync-state.json"),
      JSON.stringify(syncState)
    );

    vi.doMock("../src/paths.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/paths.js")>();
      return {
        ...original,
        resolveSyncRoots: () => ({
          cursorUser,
          dotCursor: path.join(tmpDir, "dotCursor"),
        }),
        enumerateSyncFiles: async () => [
          {
            absolutePath: path.join(cursorUser, "settings.json"),
            relativeSyncKey: "cursor-user/settings.json",
          },
        ],
      };
    });

    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();

    const remoteChecksums = {
      "cursor-user/settings.json": sha256(originalContent),
    };

    const conflicts = await detectConflicts(context, remoteChecksums);
    expect(conflicts.length).toBe(0);
  });

  it("detects no conflict when only remote changed", async () => {
    const cursorUser = path.join(tmpDir, "cursorUser");
    await fs.mkdir(cursorUser, { recursive: true });

    const originalContent = "original";

    await fs.writeFile(path.join(cursorUser, "settings.json"), originalContent);

    const syncState = {
      lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
      lastSyncDirection: "push" as const,
      gistId: "test-gist",
      localChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
      remoteChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
    };

    await fs.writeFile(
      path.join(storageDir, "sync-state.json"),
      JSON.stringify(syncState)
    );

    vi.doMock("../src/paths.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/paths.js")>();
      return {
        ...original,
        resolveSyncRoots: () => ({
          cursorUser,
          dotCursor: path.join(tmpDir, "dotCursor"),
        }),
        enumerateSyncFiles: async () => [
          {
            absolutePath: path.join(cursorUser, "settings.json"),
            relativeSyncKey: "cursor-user/settings.json",
          },
        ],
      };
    });

    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();

    const remoteChecksums = {
      "cursor-user/settings.json": sha256("remote-changed"),
    };

    const conflicts = await detectConflicts(context, remoteChecksums);
    expect(conflicts.length).toBe(0);
  });

  it("getUnresolvedConflicts filters resolved and skip entries", async () => {
    const {
      getUnresolvedConflicts,
      setPendingResolutionsForTests,
      clearConflicts,
    } = await import("../src/conflicts.js");

    const conflicts = [
      {
        relativeSyncKey: "cursor-user/settings.json",
        localChecksum: "a",
        remoteChecksum: "b",
        baseChecksum: "c",
      },
      {
        relativeSyncKey: "cursor-user/keybindings.json",
        localChecksum: "d",
        remoteChecksum: "e",
        baseChecksum: "f",
      },
      {
        relativeSyncKey: "cursor-user/extensions.json",
        localChecksum: "g",
        remoteChecksum: "h",
        baseChecksum: "i",
      },
    ];

    setPendingResolutionsForTests([
      { relativeSyncKey: "cursor-user/settings.json", resolution: "keepLocal" },
      { relativeSyncKey: "cursor-user/keybindings.json", resolution: "skip" },
    ]);

    const unresolved = getUnresolvedConflicts(conflicts);
    expect(unresolved.map((c) => c.relativeSyncKey)).toEqual([
      "cursor-user/keybindings.json",
      "cursor-user/extensions.json",
    ]);

    setPendingResolutionsForTests([
      { relativeSyncKey: "cursor-user/settings.json", resolution: "keepRemote" },
      { relativeSyncKey: "cursor-user/keybindings.json", resolution: "keepLocal" },
      { relativeSyncKey: "cursor-user/extensions.json", resolution: "keepRemote" },
    ]);
    expect(getUnresolvedConflicts(conflicts)).toEqual([]);

    await clearConflicts();
  });

  it("loadPendingResolutions restores from globalState", async () => {
    const stored = [
      {
        relativeSyncKey: "cursor-user/settings.json",
        resolution: "keepLocal" as const,
      },
    ];
    const context = {
      ...makeContext(),
      globalState: {
        get: vi.fn().mockReturnValue(stored),
        update: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockReturnValue([]),
      },
    } as unknown as import("vscode").ExtensionContext;

    const {
      loadPendingResolutions,
      getResolutionForKey,
      clearConflicts,
    } = await import("../src/conflicts.js");

    await loadPendingResolutions(context);
    expect(getResolutionForKey("cursor-user/settings.json")).toBe("keepLocal");
    await clearConflicts();
  });

  it("registerPendingConflicts clears context when empty", async () => {
    const vscode = await import("vscode");
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { registerPendingConflicts, getPendingConflicts } = await import(
      "../src/conflicts.js"
    );
    await registerPendingConflicts([
      {
        relativeSyncKey: "cursor-user/settings.json",
        localChecksum: "a",
        remoteChecksum: "b",
        baseChecksum: "c",
      },
    ]);
    expect(getPendingConflicts()).toHaveLength(1);

    await registerPendingConflicts([]);
    expect(getPendingConflicts()).toHaveLength(0);
    expect(executeCommand).toHaveBeenCalledWith(
      "setContext",
      "cursorSync.hasConflicts",
      false
    );
  });

  describe("gateUnresolvedConflicts", () => {
    const sample = {
      relativeSyncKey: "cursor-user/settings.json",
      localChecksum: "a",
      remoteChecksum: "b",
      baseChecksum: "c",
    };

    it("scheduled returns unresolved without prompting", async () => {
      const vscode = await import("vscode");
      const executeCommand = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockResolvedValue(undefined);

      const { gateUnresolvedConflicts, clearConflicts } = await import(
        "../src/conflicts.js"
      );
      const result = await gateUnresolvedConflicts("scheduled", [sample]);
      expect(result).toEqual({ unresolved: [sample], prompted: false });
      expect(executeCommand).not.toHaveBeenCalledWith(
        "cursorSync.resolveConflicts"
      );
      await clearConflicts();
    });

    it("already-resolved keepLocal/keepRemote does not prompt", async () => {
      const vscode = await import("vscode");
      const executeCommand = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockResolvedValue(undefined);

      const {
        gateUnresolvedConflicts,
        setPendingResolutionsForTests,
        clearConflicts,
      } = await import("../src/conflicts.js");
      setPendingResolutionsForTests([
        { relativeSyncKey: sample.relativeSyncKey, resolution: "keepLocal" },
      ]);
      const result = await gateUnresolvedConflicts("manual", [sample]);
      expect(result).toEqual({ unresolved: [], prompted: false });
      expect(executeCommand).not.toHaveBeenCalledWith(
        "cursorSync.resolveConflicts"
      );
      await clearConflicts();
    });

    it("manual skip leaves unresolved after prompt", async () => {
      const {
        gateUnresolvedConflicts,
        setPendingResolutionsForTests,
        clearConflicts,
      } = await import("../src/conflicts.js");
      const vscode = await import("vscode");
      const executeCommand = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockImplementation(async (cmd: string) => {
          if (cmd === "cursorSync.resolveConflicts") {
            setPendingResolutionsForTests([
              { relativeSyncKey: sample.relativeSyncKey, resolution: "skip" },
            ]);
          }
        });

      const result = await gateUnresolvedConflicts("manual", [sample]);
      expect(result.prompted).toBe(true);
      expect(result.unresolved).toEqual([sample]);
      expect(executeCommand).toHaveBeenCalledWith("cursorSync.resolveConflicts");
      await clearConflicts();
    });

    it("manual cancel leaves unresolved after prompt", async () => {
      const vscode = await import("vscode");
      const executeCommand = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockResolvedValue(undefined);

      const { gateUnresolvedConflicts, clearConflicts } = await import(
        "../src/conflicts.js"
      );
      const result = await gateUnresolvedConflicts("manual", [sample]);
      expect(result.prompted).toBe(true);
      expect(result.unresolved).toEqual([sample]);
      expect(executeCommand).toHaveBeenCalledWith("cursorSync.resolveConflicts");
      await clearConflicts();
    });

    it("manual full resolve returns prompted with empty unresolved", async () => {
      const {
        gateUnresolvedConflicts,
        setPendingResolutionsForTests,
        clearConflicts,
      } = await import("../src/conflicts.js");
      const vscode = await import("vscode");
      const executeCommand = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockImplementation(async (cmd: string) => {
          if (cmd === "cursorSync.resolveConflicts") {
            setPendingResolutionsForTests([
              {
                relativeSyncKey: sample.relativeSyncKey,
                resolution: "keepRemote",
              },
            ]);
          }
        });

      const result = await gateUnresolvedConflicts("syncNow", [sample]);
      expect(result).toEqual({ unresolved: [], prompted: true });
      expect(executeCommand).toHaveBeenCalledWith("cursorSync.resolveConflicts");
    await clearConflicts();
  });

  it("applyConflictResolutionToAll sets one decision for every pending file", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const {
      registerPendingConflicts,
      applyConflictResolutionToAll,
      getResolutionForKey,
      getUnresolvedConflicts,
      getPendingConflicts,
      clearConflicts,
    } = await import("../src/conflicts.js");
    await registerPendingConflicts([
      {
        relativeSyncKey: "cursor-user/settings.json",
        localChecksum: "a",
        remoteChecksum: "b",
        baseChecksum: "c",
      },
      {
        relativeSyncKey: "cursor-user/keybindings.json",
        localChecksum: "d",
        remoteChecksum: "e",
        baseChecksum: "f",
      },
    ]);
    await applyConflictResolutionToAll("keepLocal");
    expect(getResolutionForKey("cursor-user/settings.json")).toBe("keepLocal");
    expect(getResolutionForKey("cursor-user/keybindings.json")).toBe("keepLocal");
    expect(getUnresolvedConflicts(getPendingConflicts())).toEqual([]);
    await clearConflicts();
  });
});
});
