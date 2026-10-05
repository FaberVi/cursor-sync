import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  planLocalDeletes,
  pruneEmptyAncestors,
  isProtectedLocalDeleteKey,
} from "../src/sync-local-deletes.js";

const CURSOR_CHAT_SYNC_KEY = "dot-cursor/cursor-chat.json";
const CHAT_BUNDLES_SYNC_KEY = "dot-cursor/chat-bundles.json";

describe("planLocalDeletes", () => {
  const local = [
    "dot-cursor/skills/a/SKILL.md",
    "dot-cursor/skills/b/SKILL.md",
    "dot-cursor/skills/new-local/SKILL.md",
    CURSOR_CHAT_SYNC_KEY,
  ];

  it("mirror deletes all local-only except keepLocal and protected", () => {
    const planned = planLocalDeletes({
      mode: "mirror",
      localSyncKeys: local,
      remoteChecksums: {
        "dot-cursor/skills/a/SKILL.md": "aaa",
      },
      previousRemoteChecksums: {
        "dot-cursor/skills/a/SKILL.md": "aaa",
        "dot-cursor/skills/b/SKILL.md": "bbb",
      },
      keepLocalKeys: new Set(),
    });
    expect(planned).toEqual(["dot-cursor/skills/b/SKILL.md", "dot-cursor/skills/new-local/SKILL.md"]);
  });

  it("mirror respects keepLocal", () => {
    const planned = planLocalDeletes({
      mode: "mirror",
      localSyncKeys: local,
      remoteChecksums: {
        "dot-cursor/skills/a/SKILL.md": "aaa",
      },
      previousRemoteChecksums: {},
      keepLocalKeys: new Set(["dot-cursor/skills/b/SKILL.md"]),
    });
    expect(planned).toEqual(["dot-cursor/skills/new-local/SKILL.md"]);
  });

  it("remoteRemoved only deletes keys that were on previous remote", () => {
    const planned = planLocalDeletes({
      mode: "remoteRemoved",
      localSyncKeys: local,
      remoteChecksums: {
        "dot-cursor/skills/a/SKILL.md": "aaa",
      },
      previousRemoteChecksums: {
        "dot-cursor/skills/a/SKILL.md": "aaa",
        "dot-cursor/skills/b/SKILL.md": "bbb",
      },
      keepLocalKeys: new Set(),
    });
    expect(planned).toEqual(["dot-cursor/skills/b/SKILL.md"]);
    expect(planned).not.toContain("dot-cursor/skills/new-local/SKILL.md");
  });

  it("remoteRemoved respects keepLocal over remote delete", () => {
    const planned = planLocalDeletes({
      mode: "remoteRemoved",
      localSyncKeys: ["dot-cursor/skills/b/SKILL.md"],
      remoteChecksums: {},
      previousRemoteChecksums: {
        "dot-cursor/skills/b/SKILL.md": "bbb",
      },
      keepLocalKeys: new Set(["dot-cursor/skills/b/SKILL.md"]),
    });
    expect(planned).toEqual([]);
  });

  it("cold start previousRemote empty → remoteRemoved is no-op for local-new", () => {
    const planned = planLocalDeletes({
      mode: "remoteRemoved",
      localSyncKeys: ["dot-cursor/skills/new-local/SKILL.md"],
      remoteChecksums: {},
      previousRemoteChecksums: {},
      keepLocalKeys: new Set(),
    });
    expect(planned).toEqual([]);
  });

  it("protects chat sync keys", () => {
    expect(isProtectedLocalDeleteKey(CURSOR_CHAT_SYNC_KEY)).toBe(true);
    expect(isProtectedLocalDeleteKey(CHAT_BUNDLES_SYNC_KEY)).toBe(true);
  });
});

describe("applyLocalDeletes partial failure", () => {
  const tmpDir = path.join(os.tmpdir(), "cursor-sync-apply-del-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("PartialLocalDeleteError includes keys deleted before failure", async () => {
    const { applyLocalDeletes, PartialLocalDeleteError } = await import(
      "../src/sync-local-deletes.js"
    );
    const roots = {
      cursorUser: path.join(tmpDir, "user"),
      dotCursor: path.join(tmpDir, "dot"),
    };
    await fs.mkdir(path.join(roots.dotCursor, "skills", "a"), { recursive: true });
    // Second target is a non-empty directory: fs.rm without recursive fails
    await fs.mkdir(path.join(roots.dotCursor, "skills", "b", "nested"), { recursive: true });
    await fs.writeFile(path.join(roots.dotCursor, "skills", "a", "SKILL.md"), "a");
    await fs.writeFile(path.join(roots.dotCursor, "skills", "b", "nested", "x.txt"), "x");

    const context = {
      globalStorageUri: { fsPath: path.join(tmpDir, "storage") },
    } as import("vscode").ExtensionContext;

    let caught: unknown;
    try {
      await applyLocalDeletes(
        context,
        [
          "dot-cursor/skills/a/SKILL.md",
          // maps to .../skills/b which is a directory with children
          "dot-cursor/skills/b",
        ],
        roots
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PartialLocalDeleteError);
    const pe = caught as InstanceType<typeof PartialLocalDeleteError>;
    expect(pe.deletedKeys).toEqual(["dot-cursor/skills/a/SKILL.md"]);
    expect(pe.failedKey).toBe("dot-cursor/skills/b");
    expect(pe.backupEntries.length).toBeGreaterThan(0);
  });
});

describe("pruneEmptyAncestors", () => {
  const tmpDir = path.join(os.tmpdir(), "cursor-sync-prune-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("removes empty parents up to stop root", async () => {
    const file = path.join(tmpDir, "skills", "gone", "SKILL.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "x");
    await fs.rm(file);

    await pruneEmptyAncestors(file, [tmpDir]);

    await expect(fs.access(path.join(tmpDir, "skills", "gone"))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, "skills"))).rejects.toThrow();
    await expect(fs.access(tmpDir)).resolves.toBeUndefined();
  });

  it("stops when a directory is not empty", async () => {
    const keep = path.join(tmpDir, "skills", "keep", "SKILL.md");
    const gone = path.join(tmpDir, "skills", "gone", "SKILL.md");
    await fs.mkdir(path.dirname(keep), { recursive: true });
    await fs.mkdir(path.dirname(gone), { recursive: true });
    await fs.writeFile(keep, "keep");
    await fs.writeFile(gone, "gone");
    await fs.rm(gone);

    await pruneEmptyAncestors(gone, [tmpDir]);

    await expect(fs.access(path.join(tmpDir, "skills", "gone"))).rejects.toThrow();
    await expect(fs.readFile(keep, "utf-8")).resolves.toBe("keep");
  });
});
