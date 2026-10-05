import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { classifyPullConflicts, overlayPlanWithResolutions, allConflictsResolved, applyKeepLocalChecksums } from "../src/sync-conflicts.js";
import type { PullReplacePlan } from "../src/sync-copy.js";
import { CURSOR_CHAT_SYNC_KEY } from "../src/chat-sync-collection.js";

describe("classifyPullConflicts", () => {
  it("flags both sides modified as a conflict", () => {
    const result = classifyPullConflicts({
      baseChecksums: { "cursor-user/settings.json": "base" },
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        relativeSyncKey: "cursor-user/settings.json",
        kind: "bothModified",
      }),
    ]);
  });

  it("treats remote delete of a locally changed file as deletedRemote", () => {
    const result = classifyPullConflicts({
      baseChecksums: { "dot-cursor/rules/a.mdc": "base" },
      localChecksums: { "dot-cursor/rules/a.mdc": "local" },
      remoteChecksums: {},
    });
    expect(result.conflicts[0]?.kind).toBe("deletedRemote");
  });

  it("treats local delete of a remotely changed file as deletedLocal", () => {
    const result = classifyPullConflicts({
      baseChecksums: { "dot-cursor/rules/a.mdc": "base" },
      localChecksums: {},
      remoteChecksums: { "dot-cursor/rules/a.mdc": "remote" },
    });
    expect(result.conflicts[0]?.kind).toBe("deletedLocal");
  });

  it("does not conflict when only remote changed", () => {
    const result = classifyPullConflicts({
      baseChecksums: { "cursor-user/settings.json": "base" },
      localChecksums: { "cursor-user/settings.json": "base" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.autoKeepRemote).toContain("cursor-user/settings.json");
  });

  it("does not conflict when only local changed", () => {
    const result = classifyPullConflicts({
      baseChecksums: { "cursor-user/settings.json": "base" },
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "base" },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.autoKeepLocal).toContain("cursor-user/settings.json");
  });

  it("conflicts when there is no base and both sides differ", () => {
    const result = classifyPullConflicts({
      baseChecksums: {},
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    });
    expect(result.conflicts[0]?.kind).toBe("bothModified");
  });

  it("excludes the chat collection key", () => {
    const result = classifyPullConflicts({
      baseChecksums: { [CURSOR_CHAT_SYNC_KEY]: "base" },
      localChecksums: { [CURSOR_CHAT_SYNC_KEY]: "local" },
      remoteChecksums: { [CURSOR_CHAT_SYNC_KEY]: "remote" },
    });
    expect(result.conflicts).toEqual([]);
  });
});

describe("overlayPlanWithResolutions", () => {
  const plan: PullReplacePlan = {
    filesToWrite: [
      {
        syncKey: "cursor-user/settings.json",
        absolutePath: "/tmp/settings.json",
        content: Buffer.from("{}"),
      },
    ],
    keysToDelete: ["dot-cursor/rules/gone.mdc"],
    skillReplace: [],
    skillDeleteLocalOnly: [],
    remoteChecksums: {},
  };

  it("drops keepLocal keys from writes and deletes", () => {
    const next = overlayPlanWithResolutions(plan, [
      { relativeSyncKey: "cursor-user/settings.json", resolution: "keepLocal" },
      { relativeSyncKey: "dot-cursor/rules/gone.mdc", resolution: "keepLocal" },
    ]);
    expect(next.filesToWrite).toEqual([]);
    expect(next.keysToDelete).toEqual([]);
  });
});

describe("allConflictsResolved", () => {
  const conflicts = [
    {
      relativeSyncKey: "a",
      localChecksum: "1",
      remoteChecksum: "2",
      baseChecksum: "0",
      kind: "bothModified" as const,
    },
  ];

  it("is false while a row is undecided", () => {
    expect(allConflictsResolved(conflicts, {})).toBe(false);
    expect(allConflictsResolved(conflicts, { a: "skip" })).toBe(false);
  });

  it("is true when every row is keepLocal or keepRemote", () => {
    expect(allConflictsResolved(conflicts, { a: "keepLocal" })).toBe(true);
  });
});

describe("applyKeepLocalChecksums", () => {
  it("restores the previous base for keepLocal keys", () => {
    const next = applyKeepLocalChecksums(
      { a: "remote", b: "remote" },
      { a: "old" },
      ["a"]
    );
    expect(next.a).toBe("old");
    expect(next.b).toBe("remote");
  });
});
