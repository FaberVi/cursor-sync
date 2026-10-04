import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  checksumsWithoutDeletions,
  conflictsWithoutDeletions,
  deletionPrefixes,
  detectIntentionalDeletions,
  expandDeletions,
  omitIntentionalDeletions,
  pendingDeletionsAfterPush,
  resolveIntentionalDeletions,
  withoutDeletionKeys,
} from "../src/intentional-deletions.js";
import type { PullReplacePlan } from "../src/sync-copy.js";
import { CURSOR_CHAT_SYNC_KEY } from "../src/chat-sync-collection.js";

const RULE = "dot-cursor/rules/old.mdc";
const SKILL = "dot-cursor/skills/foo/SKILL.md";
const SIBLING = "dot-cursor/skills/foo/extra.md";
const NEW_REMOTE = "dot-cursor/skills/foo/from-remote.md";

function plan(files: string[], skillReplace: string[] = []): PullReplacePlan {
  return {
    filesToWrite: files.map((syncKey) => ({
      syncKey,
      absolutePath: syncKey,
      content: Buffer.from("x"),
    })),
    keysToDelete: ["dot-cursor/skills/other/SKILL.md"],
    skillReplace,
    skillDeleteLocalOnly: ["dot-cursor/skills/local-only"],
    remoteChecksums: { [RULE]: "remote" },
  };
}

describe("detectIntentionalDeletions", () => {
  it("selects a previously synced key that is missing locally and still on the clone", () => {
    expect(
      detectIntentionalDeletions({
        localChecksums: { [RULE]: "base" },
        localHashes: {},
        cloneChecksums: { [RULE]: "remote" },
      })
    ).toEqual([RULE]);
  });

  it("keeps selecting from pendingDeletions after checksums were cleared", () => {
    expect(
      detectIntentionalDeletions({
        localChecksums: {},
        pendingDeletions: [RULE],
        localHashes: {},
        cloneChecksums: { [RULE]: "remote" },
      })
    ).toEqual([RULE]);
  });

  it("ignores a key that was never synced and a key already absent from the clone", () => {
    expect(
      detectIntentionalDeletions({
        localChecksums: { [RULE]: "base" },
        localHashes: {},
        cloneChecksums: { "dot-cursor/rules/other.mdc": "x" },
      })
    ).toEqual([]);
    expect(
      detectIntentionalDeletions({
        localChecksums: {},
        localHashes: {},
        cloneChecksums: { "dot-cursor/rules/new.mdc": "x" },
      })
    ).toEqual([]);
  });

  it("ignores toggle-off MCP keys", () => {
    expect(
      detectIntentionalDeletions({
        localChecksums: { "dot-cursor/mcp.json": "mcp" },
        localHashes: {},
        cloneChecksums: { "dot-cursor/mcp.json": "mcp" },
      })
    ).toEqual([]);
  });

  it("ignores chat collection and legacy chat bundles", () => {
    expect(
      detectIntentionalDeletions({
        localChecksums: {
          [CURSOR_CHAT_SYNC_KEY]: "chat",
          "dot-cursor/chat-bundles.json": "legacy",
        },
        localHashes: {},
        cloneChecksums: {
          [CURSOR_CHAT_SYNC_KEY]: "chat",
          "dot-cursor/chat-bundles.json": "legacy",
        },
      })
    ).toEqual([]);
  });

  it("does not select a key that is still on disk", () => {
    expect(
      detectIntentionalDeletions({
        localChecksums: { [RULE]: "base" },
        localHashes: { [RULE]: "local" },
        cloneChecksums: { [RULE]: "remote" },
      })
    ).toEqual([]);
  });
});

describe("omitIntentionalDeletions", () => {
  it("drops the deleted key and its skill replace prefix, and keeps siblings", () => {
    const next = omitIntentionalDeletions(
      plan([SKILL, SIBLING, NEW_REMOTE, RULE], ["dot-cursor/skills/foo"]),
      [SKILL]
    );
    expect(next.filesToWrite.map((file) => file.syncKey)).toEqual([
      SIBLING,
      NEW_REMOTE,
      RULE,
    ]);
    expect(next.skillReplace).toEqual([]);
    expect(next.keysToDelete).toEqual(["dot-cursor/skills/other/SKILL.md"]);
    expect(next.skillDeleteLocalOnly).toEqual(["dot-cursor/skills/local-only"]);
  });
});

describe("filters", () => {
  it("strips deletion keys from keep-local lists, conflicts, and checksums", () => {
    expect(withoutDeletionKeys([RULE, SIBLING], [RULE])).toEqual([SIBLING]);
    expect(
      conflictsWithoutDeletions(
        [
          {
            relativeSyncKey: RULE,
            localChecksum: "",
            remoteChecksum: "remote",
            baseChecksum: "base",
            kind: "deletedLocal",
          },
          {
            relativeSyncKey: SIBLING,
            localChecksum: "a",
            remoteChecksum: "b",
            baseChecksum: "c",
            kind: "bothModified",
          },
        ],
        [RULE]
      ).map((row) => row.relativeSyncKey)
    ).toEqual([SIBLING]);
    expect(checksumsWithoutDeletions({ [RULE]: "a", [SIBLING]: "b" }, [RULE])).toEqual({
      [SIBLING]: "b",
    });
  });

  it("pendingDeletionsAfterPush drops removed and rewritten keys", () => {
    expect(
      pendingDeletionsAfterPush({
        pending: [RULE, SIBLING, NEW_REMOTE],
        writtenChecksums: { [SIBLING]: "wrote" },
        cloneChecksums: { [NEW_REMOTE]: "still" },
      })
    ).toEqual([NEW_REMOTE]);
  });

  it("keeps a toggle-off MCP key that the clone hash omits", () => {
    expect(
      pendingDeletionsAfterPush({
        pending: ["dot-cursor/mcp.json", RULE],
        writtenChecksums: {},
        cloneChecksums: {},
      })
    ).toEqual(["dot-cursor/mcp.json"]);
  });
});

describe("empty-folder expansion", () => {
  const keepRule = "dot-cursor/rules/keep.mdc";
  const notes = "dot-cursor/skills/foo/notes.md";
  const bar = "dot-cursor/skills/bar/SKILL.md";

  it("tombstones a skill folder with no local files and leaves rules that still have a sibling", () => {
    const localKeys = [keepRule, bar, "cursor-user/settings.json"];
    const detected = [RULE, SKILL];
    expect(deletionPrefixes(localKeys, detected)).toEqual(["dot-cursor/skills/foo"]);
    expect(expandDeletions([RULE, SKILL, notes, keepRule, bar], detected, deletionPrefixes(localKeys, detected))).toEqual([
      RULE,
      SKILL,
      notes,
    ]);
  });

  it("does not treat an enumerated file as deleted when its hash is missing", () => {
    expect(
      detectIntentionalDeletions({
        localChecksums: { [RULE]: "base" },
        localHashes: {},
        localKeys: [RULE],
        cloneChecksums: { [RULE]: "remote" },
      })
    ).toEqual([]);
  });

  it("reset does not expand or omit", () => {
    expect(
      resolveIntentionalDeletions({
        resetToRemote: true,
        localChecksums: { [SKILL]: "base" },
        localHashes: {},
        localKeys: [],
        cloneChecksums: { [SKILL]: "remote", [NEW_REMOTE]: "new" },
      })
    ).toEqual([]);
  });

  it("keeps a never-seen file under an empty skill in the next detect via pending", () => {
    const notes = "dot-cursor/skills/foo/notes.md";
    const first = resolveIntentionalDeletions({
      resetToRemote: false,
      localChecksums: { [SKILL]: "base" },
      localHashes: {},
      localKeys: [],
      cloneChecksums: { [SKILL]: "remote", [notes]: "new" },
    });
    expect(first).toEqual([SKILL, notes]);
    expect(
      resolveIntentionalDeletions({
        resetToRemote: false,
        localChecksums: {},
        pendingDeletions: first,
        localHashes: {},
        localKeys: [],
        cloneChecksums: { [SKILL]: "remote", [notes]: "new" },
      })
    ).toEqual([SKILL, notes]);
  });
});
