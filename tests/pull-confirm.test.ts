import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  buildSyncConfirmModel,
  cloneDiffPathToSyncKey,
  listLocalOnlyKeys,
  syncKeysFromDiffNameOnly,
} from "../src/pull-confirm.js";

describe("cloneDiffPathToSyncKey", () => {
  it("maps nested clone paths under basePath", () => {
    expect(
      cloneDiffPathToSyncKey("cursor-sync/dot-cursor/skills/foo/SKILL.md", "cursor-sync")
    ).toBe("dot-cursor/skills/foo/SKILL.md");
    expect(
      cloneDiffPathToSyncKey("cursor-sync/manifest.json", "cursor-sync")
    ).toBeUndefined();
  });
});

describe("syncKeysFromDiffNameOnly", () => {
  it("maps clone paths and skips manifest", () => {
    expect(
      syncKeysFromDiffNameOnly(
        "cursor-sync/dot-cursor/skills/foo/SKILL.md\ncursor-sync/manifest.json\n",
        "cursor-sync"
      )
    ).toEqual(["dot-cursor/skills/foo/SKILL.md"]);
  });
});

describe("listLocalOnlyKeys", () => {
  it("keeps keys absent from remote and previous remote", () => {
    expect(
      listLocalOnlyKeys({
        localKeys: ["dot-cursor/skills/bar/SKILL.md", "cursor-user/settings.json"],
        remoteChecksums: { "cursor-user/settings.json": "x" },
        previousRemoteChecksums: { "cursor-user/settings.json": "x" },
      })
    ).toEqual(["dot-cursor/skills/bar/SKILL.md"]);
  });
});

describe("buildSyncConfirmModel", () => {
  const incoming = {
    subjects: ["add skill foo"],
    incomingSyncKeys: ["dot-cursor/skills/foo/SKILL.md"],
    incomingDisplayNames: ["foo"],
  };

  it("keeps Sync Now local-only keys and conflict keys", () => {
    const model = buildSyncConfirmModel({
      mode: "syncNow",
      incoming,
      localOnlyKeys: ["dot-cursor/skills/bar/SKILL.md"],
      conflictKeys: ["cursor-user/settings.json"],
      n: 2,
      m: 0,
    });
    expect(model.mode).toBe("syncNow");
    expect(model.localOnlyKeys).toEqual(["dot-cursor/skills/bar/SKILL.md"]);
    expect(model.conflictKeys).toEqual(["cursor-user/settings.json"]);
    expect(model.n).toBe(2);
    expect(model.k).toBe(0);
  });

  it("marks Pull as a mirror that will delete local-only files", () => {
    const model = buildSyncConfirmModel({
      mode: "pullMirror",
      incoming,
      localOnlyKeys: ["dot-cursor/skills/bar/SKILL.md"],
      n: 2,
      m: 1,
      k: 3,
    });
    expect(model.mode).toBe("pullMirror");
    expect(model.localOnlyKeys).toEqual(["dot-cursor/skills/bar/SKILL.md"]);
    expect(model.k).toBe(3);
  });

  it("uses resetMirror mode for Reset to remote", () => {
    const model = buildSyncConfirmModel({
      mode: "resetMirror",
      incoming,
      n: 1,
      m: 0,
    });
    expect(model.mode).toBe("resetMirror");
    expect(model.localOnlyKeys).toEqual([]);
    expect(model.conflictKeys).toEqual([]);
  });
});
