import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  buildPullMirrorConfirmMessage,
  buildSyncNowConfirmMessage,
  cloneDiffPathToSyncKey,
  formatNameList,
  listLocalOnlyKeys,
  PULL_CONFIRM_NAME_CAP,
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

describe("formatNameList", () => {
  it("caps at 8 names", () => {
    const names = Array.from({ length: PULL_CONFIRM_NAME_CAP + 2 }, (_, i) => `f${i}`);
    const text = formatNameList(names);
    expect(text).toContain("and 2 more");
    expect(text.split(", ").length).toBe(PULL_CONFIRM_NAME_CAP + 1);
  });
});

describe("confirm builders", () => {
  const incoming = {
    subjects: ["add skill foo"],
    incomingSyncKeys: ["dot-cursor/skills/foo/SKILL.md"],
    incomingDisplayNames: ["foo"],
  };

  it("says Sync Now will keep local-only files", () => {
    const text = buildSyncNowConfirmMessage({
      incoming,
      localOnlyKeys: ["dot-cursor/skills/bar/SKILL.md"],
      conflictCount: 1,
      n: 2,
      m: 0,
    });
    expect(text).toContain("add skill foo");
    expect(text).toContain("bar");
    expect(text).toContain("kept");
    expect(text).toContain("editor tab");
  });

  it("says Pull is a mirror that deletes local-only files", () => {
    const text = buildPullMirrorConfirmMessage({
      incoming,
      localOnlyKeys: ["dot-cursor/skills/bar/SKILL.md"],
      n: 2,
      m: 1,
      k: 3,
      reset: false,
    });
    expect(text.toLowerCase()).toContain("mirror");
    expect(text).toContain("deleted");
    expect(text).toContain("bar");
  });

  it("uses Reset wording for resetToRemote", () => {
    const text = buildPullMirrorConfirmMessage({
      incoming,
      localOnlyKeys: [],
      n: 1,
      m: 0,
      k: 0,
      reset: true,
    });
    expect(text).toContain("Reset to remote");
  });
});
