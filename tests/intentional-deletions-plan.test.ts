import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { planCloneToCursor } from "../src/sync-copy.js";
import * as paths from "../src/paths.js";
import {
  omitIntentionalDeletions,
  resolveIntentionalDeletions,
} from "../src/intentional-deletions.js";

describe("planCloneToCursor intentional deletions", () => {
  let tmp = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  it("does not write a deleted rule, a deleted skill, or a new file inside that skill", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-deletions-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    const base = path.join(clone, "cursor-sync");
    await fs.mkdir(path.join(dotCursor, "rules"), { recursive: true });
    await fs.mkdir(path.join(dotCursor, "skills", "bar"), { recursive: true });
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(path.join(base, "dot-cursor", "rules"), { recursive: true });
    await fs.mkdir(path.join(base, "dot-cursor", "skills", "foo"), { recursive: true });
    await fs.mkdir(path.join(base, "dot-cursor", "skills", "bar"), { recursive: true });
    await fs.mkdir(path.join(base, "cursor-user"), { recursive: true });

    const settings = path.join(cursorUser, "settings.json");
    const keep = path.join(dotCursor, "rules", "keep.mdc");
    const bar = path.join(dotCursor, "skills", "bar", "SKILL.md");
    await fs.writeFile(settings, "{}");
    await fs.writeFile(keep, "local-keep");
    await fs.writeFile(bar, "local-bar");
    await fs.writeFile(path.join(base, "cursor-user", "settings.json"), "{}");
    await fs.writeFile(path.join(base, "dot-cursor", "rules", "keep.mdc"), "remote-keep");
    await fs.writeFile(path.join(base, "dot-cursor", "rules", "old.mdc"), "remote-old");
    await fs.writeFile(path.join(base, "dot-cursor", "skills", "foo", "SKILL.md"), "remote-foo");
    await fs.writeFile(path.join(base, "dot-cursor", "skills", "foo", "notes.md"), "never-local");
    await fs.writeFile(path.join(base, "dot-cursor", "skills", "bar", "SKILL.md"), "remote-bar");

    const localKeys = [
      "cursor-user/settings.json",
      "dot-cursor/rules/keep.mdc",
      "dot-cursor/skills/bar/SKILL.md",
    ];
    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
      { absolutePath: keep, relativeSyncKey: "dot-cursor/rules/keep.mdc" },
      { absolutePath: bar, relativeSyncKey: "dot-cursor/skills/bar/SKILL.md" },
    ]);

    const plan = await planCloneToCursor(clone, "cursor-sync");
    const deletionKeys = resolveIntentionalDeletions({
      resetToRemote: false,
      localChecksums: {
        "dot-cursor/rules/old.mdc": "base-old",
        "dot-cursor/skills/foo/SKILL.md": "base-foo",
        "dot-cursor/rules/keep.mdc": "base-keep",
        "dot-cursor/skills/bar/SKILL.md": "base-bar",
      },
      localHashes: {
        "cursor-user/settings.json": plan.remoteChecksums["cursor-user/settings.json"] ?? "",
        "dot-cursor/rules/keep.mdc": "local-keep-hash",
        "dot-cursor/skills/bar/SKILL.md": "local-bar-hash",
      },
      localKeys,
      cloneChecksums: plan.remoteChecksums,
    });
    const filtered = omitIntentionalDeletions(plan, deletionKeys);
    const written = filtered.filesToWrite.map((file) => file.syncKey);

    expect(written).not.toContain("dot-cursor/rules/old.mdc");
    expect(written).not.toContain("dot-cursor/skills/foo/SKILL.md");
    expect(written).not.toContain("dot-cursor/skills/foo/notes.md");
    expect(written).toContain("dot-cursor/rules/keep.mdc");
    expect(written).toContain("dot-cursor/skills/bar/SKILL.md");
    expect(filtered.skillReplace).not.toContain("dot-cursor/skills/foo");
    expect(deletionKeys).toContain("dot-cursor/skills/foo/notes.md");
  });
});
