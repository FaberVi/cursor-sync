import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  collectSkillConflictWarnings,
  isSafeSkillFolderPath,
  keyUnderSkillPrefix,
  keysCoveredBySkillFolders,
  missingRemoteSkillFiles,
  planSkillFolderWipes,
  skillConflictExtraLocalFiles,
  skillFolderAbsolutePath,
  skillFolderDisplayName,
  skillFolderPrefix,
} from "../src/sync-skill-folders.js";
import { syncKeyToGistFileName } from "../src/paths.js";

describe("skillFolderPrefix", () => {
  it("returns prefix for live skills under both roots", () => {
    expect(skillFolderPrefix("dot-cursor/skills/foo/SKILL.md")).toBe(
      "dot-cursor/skills/foo"
    );
    expect(skillFolderPrefix("dot-cursor/skills/foo/scripts/run.py")).toBe(
      "dot-cursor/skills/foo"
    );
    expect(skillFolderPrefix("cursor-user/skills/bar/SKILL.md")).toBe(
      "cursor-user/skills/bar"
    );
  });

  it("keeps cursor-user/skills/bar distinct from dot-cursor/skills/bar", () => {
    expect(skillFolderPrefix("cursor-user/skills/bar/SKILL.md")).not.toBe(
      skillFolderPrefix("dot-cursor/skills/bar/SKILL.md")
    );
  });

  it("treats a legitimate *-workspace skill with top-level SKILL.md as a skill", () => {
    expect(skillFolderPrefix("dot-cursor/skills/my-agent-workspace/SKILL.md")).toBe(
      "dot-cursor/skills/my-agent-workspace"
    );
  });

  it("returns undefined for artifacts, settings, and malformed names", () => {
    expect(
      skillFolderPrefix("dot-cursor/skills/foo-workspace/iteration-1/SKILL.md")
    ).toBeUndefined();
    expect(
      skillFolderPrefix(
        "dot-cursor/skills/foo-workspace/skill-snapshot/SKILL.md"
      )
    ).toBeUndefined();
    expect(skillFolderPrefix("dot-cursor/skills/skill-snapshot/SKILL.md")).toBeUndefined();
    expect(skillFolderPrefix("cursor-user/settings.json")).toBeUndefined();
    expect(skillFolderPrefix("dot-cursor/rules/foo.mdc")).toBeUndefined();
    expect(skillFolderPrefix("dot-cursor/commands/x.md")).toBeUndefined();
    expect(skillFolderPrefix("dot-cursor/skills")).toBeUndefined();
    expect(skillFolderPrefix("dot-cursor/skills/.")).toBeUndefined();
    expect(skillFolderPrefix("dot-cursor/skills/../escape/SKILL.md")).toBeUndefined();
  });
});

describe("keyUnderSkillPrefix", () => {
  it("matches exact prefix and children, not sibling -workspace", () => {
    const prefix = "dot-cursor/skills/foo";
    expect(keyUnderSkillPrefix("dot-cursor/skills/foo", prefix)).toBe(true);
    expect(keyUnderSkillPrefix("dot-cursor/skills/foo/SKILL.md", prefix)).toBe(true);
    expect(keyUnderSkillPrefix("dot-cursor/skills/foo/scripts/a.py", prefix)).toBe(
      true
    );
    expect(
      keyUnderSkillPrefix("dot-cursor/skills/foo-workspace/SKILL.md", prefix)
    ).toBe(false);
    expect(keyUnderSkillPrefix("dot-cursor/skills/foobar/SKILL.md", prefix)).toBe(
      false
    );
  });
});

describe("planSkillFolderWipes", () => {
  it("replaces remote skills and deletes enumerated local-only skills", () => {
    const planned = planSkillFolderWipes({
      remoteKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "cursor-user/settings.json",
      ],
      localKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/new-local/SKILL.md",
        "cursor-user/settings.json",
      ],
      keepLocalKeys: new Set(),
    });
    expect(planned.replace).toEqual(["dot-cursor/skills/foo"]);
    expect(planned.deleteLocalOnly).toEqual(["dot-cursor/skills/new-local"]);
  });

  it("skips replace and deleteLocalOnly when any file in the folder is Keep Local", () => {
    const planned = planSkillFolderWipes({
      remoteKeys: ["dot-cursor/skills/foo/SKILL.md"],
      localKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/kept/SKILL.md",
      ],
      keepLocalKeys: new Set([
        "dot-cursor/skills/foo/scripts/a.py",
        "dot-cursor/skills/kept/SKILL.md",
      ]),
    });
    expect(planned.replace).toEqual([]);
    expect(planned.deleteLocalOnly).toEqual([]);
  });

  it("does not plan wipe from artifact keys", () => {
    const planned = planSkillFolderWipes({
      remoteKeys: [
        "dot-cursor/skills/foo-workspace/iteration-1/SKILL.md",
        "dot-cursor/skills/foo-workspace/skill-snapshot/SKILL.md",
      ],
      localKeys: [
        "dot-cursor/skills/foo-workspace/iteration-1/SKILL.md",
      ],
      keepLocalKeys: new Set(),
    });
    expect(planned.replace).toEqual([]);
    expect(planned.deleteLocalOnly).toEqual([]);
  });

  it("does not treat leftover-only folders as deleteLocalOnly", () => {
    const planned = planSkillFolderWipes({
      remoteKeys: ["dot-cursor/skills/foo/SKILL.md"],
      localKeys: ["dot-cursor/skills/foo/SKILL.md"],
      keepLocalKeys: new Set(),
    });
    expect(planned.deleteLocalOnly).toEqual([]);
  });
});

describe("skillConflictExtraLocalFiles", () => {
  it("warns when a skill has a conflict plus other local files", () => {
    const warnings = skillConflictExtraLocalFiles({
      conflicts: [{ relativeSyncKey: "dot-cursor/skills/foo/SKILL.md" }],
      localSkillFileKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/foo/scripts/a.py",
      ],
    });
    expect(warnings).toEqual([{ prefix: "dot-cursor/skills/foo", extraCount: 1 }]);
  });

  it("does not warn when every local skill file is in conflict", () => {
    const warnings = skillConflictExtraLocalFiles({
      conflicts: [
        { relativeSyncKey: "dot-cursor/skills/foo/SKILL.md" },
        { relativeSyncKey: "dot-cursor/skills/foo/scripts/a.py" },
      ],
      localSkillFileKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/foo/scripts/a.py",
      ],
    });
    expect(warnings).toEqual([]);
  });

  it("does not warn for settings conflicts", () => {
    const warnings = skillConflictExtraLocalFiles({
      conflicts: [{ relativeSyncKey: "cursor-user/settings.json" }],
      localSkillFileKeys: ["cursor-user/settings.json", "cursor-user/keybindings.json"],
    });
    expect(warnings).toEqual([]);
  });

  it("counts leftover node_modules files and excludes sibling workspace", () => {
    const warnings = skillConflictExtraLocalFiles({
      conflicts: [{ relativeSyncKey: "dot-cursor/skills/foo/SKILL.md" }],
      localSkillFileKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/foo/node_modules/leftpad/index.js",
        "dot-cursor/skills/foo-workspace/SKILL.md",
        "dot-cursor/skills/foo-workspace/helper.py",
      ],
    });
    expect(warnings).toEqual([{ prefix: "dot-cursor/skills/foo", extraCount: 1 }]);
  });
});

describe("collectSkillConflictWarnings", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-skill-warn-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("walks leftover files in the skill dir and ignores the sibling workspace", async () => {
    const dotCursor = path.join(tmpDir, ".cursor");
    const foo = path.join(dotCursor, "skills", "foo");
    const workspace = path.join(dotCursor, "skills", "foo-workspace");
    await fs.mkdir(path.join(foo, "node_modules", "leftpad"), { recursive: true });
    await fs.writeFile(path.join(foo, "SKILL.md"), "# foo\n");
    await fs.writeFile(path.join(foo, "node_modules", "leftpad", "index.js"), "module.exports=1\n");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "SKILL.md"), "# workspace\n");
    await fs.writeFile(path.join(workspace, "helper.py"), "print(1)\n");

    const warnings = await collectSkillConflictWarnings(
      [{ relativeSyncKey: "dot-cursor/skills/foo/SKILL.md" }],
      { cursorUser: path.join(tmpDir, "user"), dotCursor }
    );
    expect(warnings).toEqual([{ prefix: "dot-cursor/skills/foo", extraCount: 1 }]);
  });
});

describe("missingRemoteSkillFiles", () => {
  it("reports replace keys absent from the snapshot", () => {
    const missing = missingRemoteSkillFiles({
      replacePrefixes: ["dot-cursor/skills/foo"],
      remoteKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/foo/scripts/a.py",
        "cursor-user/settings.json",
      ],
      remoteFileNames: new Set(["dot-cursor--skills--foo--SKILL.md"]),
      syncKeyToGistFileName,
    });
    expect(missing).toEqual(["dot-cursor/skills/foo/scripts/a.py"]);
  });

  it("does not treat denylisted leftover keys as missing snapshot files", () => {
    const missing = missingRemoteSkillFiles({
      replacePrefixes: ["dot-cursor/skills/foo"],
      remoteKeys: [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/foo/node_modules/leftpad/index.js",
      ],
      remoteFileNames: new Set(["dot-cursor--skills--foo--SKILL.md"]),
      syncKeyToGistFileName,
    });
    expect(missing).toEqual([]);
  });
});

describe("skill folder path helpers", () => {
  it("builds absolute dirs via SKILL.md dirname and rejects roots", () => {
    const roots = {
      cursorUser: path.join(os.tmpdir(), "cursor-sync-user-root"),
      dotCursor: path.join(os.tmpdir(), "cursor-sync-dot-root"),
    };
    const abs = skillFolderAbsolutePath("dot-cursor/skills/foo", roots);
    expect(abs).toBe(path.join(roots.dotCursor, "skills", "foo"));
    expect(skillFolderDisplayName("dot-cursor/skills/foo")).toBe("foo");
    expect(isSafeSkillFolderPath(abs!, roots)).toBe(true);
    expect(isSafeSkillFolderPath(roots.dotCursor, roots)).toBe(false);
    expect(isSafeSkillFolderPath(path.join(roots.dotCursor, "skills"), roots)).toBe(
      false
    );
    expect(
      isSafeSkillFolderPath(path.join(roots.dotCursor, "skills", "foo-workspace"), roots)
    ).toBe(true);
  });

  it("keysCoveredBySkillFolders uses exact prefix", () => {
    const covered = keysCoveredBySkillFolders(
      [
        "dot-cursor/skills/foo/SKILL.md",
        "dot-cursor/skills/foo-workspace/SKILL.md",
        "cursor-user/settings.json",
      ],
      ["dot-cursor/skills/foo"]
    );
    expect(covered).toEqual(["dot-cursor/skills/foo/SKILL.md"]);
  });
});
