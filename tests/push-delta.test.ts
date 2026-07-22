import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { selectPushDelta } from "../src/push-delta.js";
import type { PackagedFile } from "../src/types.js";

function pkg(content: string, checksum: string): PackagedFile {
  return { content, checksum, sizeBytes: content.length };
}

describe("selectPushDelta", () => {
  it("uploads only changed files plus leaves unchanged skipped", () => {
    const packaged = new Map<string, PackagedFile>([
      ["cursor-user/a.json", pkg("a1", "hash-a1")],
      ["cursor-user/b.json", pkg("b1", "hash-b")],
      ["cursor-user/c.json", pkg("c2", "hash-c2")],
    ]);
    const result = selectPushDelta({
      packaged,
      remoteChecksums: {
        "cursor-user/a.json": "hash-a0",
        "cursor-user/b.json": "hash-b",
        "cursor-user/c.json": "hash-c1",
      },
      existingRemoteNames: [
        "manifest.json",
        "cursor-user--a.json",
        "cursor-user--b.json",
        "cursor-user--c.json",
      ],
      forceFullUpload: false,
    });

    expect(Object.keys(result.filesToUpload).sort()).toEqual([
      "cursor-user--a.json",
      "cursor-user--c.json",
    ]);
    expect(result.uploadedSyncKeys.sort()).toEqual([
      "cursor-user/a.json",
      "cursor-user/c.json",
    ]);
    expect(result.unchangedCount).toBe(1);
    expect(result.deleteNames).toEqual([]);
    expect(result.isNoOp).toBe(false);
  });

  it("is a no-op when everything matches", () => {
    const packaged = new Map<string, PackagedFile>([
      ["cursor-user/a.json", pkg("a", "hash-a")],
      ["cursor-user/b.json", pkg("b", "hash-b")],
    ]);
    const result = selectPushDelta({
      packaged,
      remoteChecksums: {
        "cursor-user/a.json": "hash-a",
        "cursor-user/b.json": "hash-b",
      },
      existingRemoteNames: [
        "manifest.json",
        "cursor-user--a.json",
        "cursor-user--b.json",
      ],
      forceFullUpload: false,
    });

    expect(result.filesToUpload).toEqual({});
    expect(result.uploadedSyncKeys).toEqual([]);
    expect(result.unchangedCount).toBe(2);
    expect(result.deleteNames).toEqual([]);
    expect(result.isNoOp).toBe(true);
  });

  it("marks removed remote files for delete", () => {
    const packaged = new Map<string, PackagedFile>([
      ["cursor-user/a.json", pkg("a", "hash-a")],
    ]);
    const result = selectPushDelta({
      packaged,
      remoteChecksums: {
        "cursor-user/a.json": "hash-a",
        "cursor-user/old.json": "hash-old",
      },
      existingRemoteNames: [
        "manifest.json",
        "cursor-user--a.json",
        "cursor-user--old.json",
      ],
      forceFullUpload: false,
    });

    expect(result.filesToUpload).toEqual({});
    expect(result.deleteNames).toEqual(["cursor-user--old.json"]);
    expect(result.isNoOp).toBe(false);
  });

  it("forceFullUpload includes every packaged file", () => {
    const packaged = new Map<string, PackagedFile>([
      ["cursor-user/a.json", pkg("a", "hash-a")],
      ["cursor-user/b.json", pkg("b", "hash-b")],
    ]);
    const result = selectPushDelta({
      packaged,
      remoteChecksums: {
        "cursor-user/a.json": "hash-a",
        "cursor-user/b.json": "hash-b",
      },
      existingRemoteNames: [],
      forceFullUpload: true,
    });

    expect(Object.keys(result.filesToUpload).sort()).toEqual([
      "cursor-user--a.json",
      "cursor-user--b.json",
    ]);
    expect(result.unchangedCount).toBe(0);
    expect(result.isNoOp).toBe(false);
  });

  it("forceFullUpload is never a no-op even with empty package", () => {
    const result = selectPushDelta({
      packaged: new Map(),
      remoteChecksums: {},
      existingRemoteNames: [],
      forceFullUpload: true,
    });
    expect(result.isNoOp).toBe(false);
    expect(result.filesToUpload).toEqual({});
  });

  it("preserveSyncKeys skips upload and protects remote deletes", () => {
    const packaged = new Map<string, PackagedFile>([
      ["cursor-user/settings.json", pkg("local", "hash-local")],
      ["cursor-user/keybindings.json", pkg("kb", "hash-kb")],
    ]);
    const result = selectPushDelta({
      packaged,
      remoteChecksums: {
        "cursor-user/settings.json": "hash-remote",
        "cursor-user/keybindings.json": "hash-kb-old",
      },
      existingRemoteNames: [
        "manifest.json",
        "cursor-user--settings.json",
        "cursor-user--keybindings.json",
      ],
      forceFullUpload: false,
      preserveSyncKeys: ["cursor-user/settings.json"],
    });

    expect(Object.keys(result.filesToUpload)).toEqual([
      "cursor-user--keybindings.json",
    ]);
    expect(result.uploadedSyncKeys).toEqual(["cursor-user/keybindings.json"]);
    expect(result.deleteNames).toEqual([]);
    expect(result.unchangedCount).toBe(1);
  });
});
