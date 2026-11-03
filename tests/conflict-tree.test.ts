import { describe, expect, it } from "vitest";
import {
  applyResolutionToFolder,
  buildConflictTree,
  descendantConflictKeys,
  folderPickState,
} from "../src/conflict-tree.js";
import type { ConflictEntry } from "../src/types.js";

const entry = (
  relativeSyncKey: string
): ConflictEntry => ({
  relativeSyncKey,
  localChecksum: "l",
  remoteChecksum: "r",
  baseChecksum: "b",
  kind: "bothModified",
});

describe("buildConflictTree", () => {
  it("groups files under folder segments", () => {
    const tree = buildConflictTree([
      entry("dot-cursor/skills/a/SKILL.md"),
      entry("dot-cursor/skills/b/SKILL.md"),
      entry("cursor-user/settings.json"),
    ]);
    expect(tree.children).toHaveLength(2);
    const dotCursor = tree.children.find(
      (n) => n.type === "folder" && n.syncKeyPrefix === "dot-cursor"
    );
    expect(dotCursor?.type).toBe("folder");
    if (dotCursor?.type !== "folder") {
      return;
    }
    const skills = dotCursor.children.find(
      (n) => n.type === "folder" && n.syncKeyPrefix === "dot-cursor/skills"
    );
    expect(skills?.type).toBe("folder");
  });
});

describe("folderPickState", () => {
  const conflicts = [
    entry("dot-cursor/skills/a/SKILL.md"),
    entry("dot-cursor/skills/b/SKILL.md"),
  ];

  it("reports local when every descendant matches", () => {
    const resolutions = {
      "dot-cursor/skills/a/SKILL.md": "keepLocal" as const,
      "dot-cursor/skills/b/SKILL.md": "keepLocal" as const,
    };
    expect(
      folderPickState(conflicts, resolutions, "dot-cursor/skills")
    ).toBe("local");
  });

  it("reports mixed when descendants differ", () => {
    const resolutions = {
      "dot-cursor/skills/a/SKILL.md": "keepLocal" as const,
      "dot-cursor/skills/b/SKILL.md": "keepRemote" as const,
    };
    expect(
      folderPickState(conflicts, resolutions, "dot-cursor/skills")
    ).toBe("mixed");
  });
});

describe("applyResolutionToFolder", () => {
  it("sets resolution on all keys under prefix", () => {
    const conflicts = [
      entry("dot-cursor/skills/a/SKILL.md"),
      entry("dot-cursor/skills/b/SKILL.md"),
      entry("cursor-user/settings.json"),
    ];
    const resolutions: Record<string, "keepLocal" | "keepRemote" | undefined> =
      {};
    applyResolutionToFolder(
      conflicts,
      resolutions,
      "dot-cursor/skills",
      "keepRemote"
    );
    expect(resolutions["dot-cursor/skills/a/SKILL.md"]).toBe("keepRemote");
    expect(resolutions["dot-cursor/skills/b/SKILL.md"]).toBe("keepRemote");
    expect(resolutions["cursor-user/settings.json"]).toBeUndefined();
    expect(descendantConflictKeys(conflicts, "dot-cursor/skills")).toHaveLength(
      2
    );
  });
});
