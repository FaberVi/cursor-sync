import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { restoreVacantSkillFoldersFromClone } from "../src/restore-vacant-skill-folders.js";
import { isVacantSkillDirectory } from "../src/sync-skill-folders.js";
import * as paths from "../src/paths.js";

describe("restoreVacantSkillFoldersFromClone", () => {
  let tmp = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  it("refills an empty skill directory and leaves a missing skill directory alone", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-vacant-"));
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    const basePath = "sync-data";
    const vacant = path.join(dotCursor, "skills", "fhub-skill-forge");
    const present = path.join(clone, basePath, "dot-cursor", "skills", "fhub-skill-forge");
    const removed = path.join(clone, basePath, "dot-cursor", "skills", "gone");
    await fs.mkdir(vacant, { recursive: true });
    await fs.mkdir(path.join(present, "agents"), { recursive: true });
    await fs.mkdir(removed, { recursive: true });
    await fs.writeFile(path.join(present, "SKILL.md"), "# forge\n");
    await fs.writeFile(path.join(present, "agents", "analyzer.md"), "analyze\n");
    await fs.writeFile(path.join(removed, "SKILL.md"), "# gone\n");

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({
      cursorUser: path.join(tmp, "user"),
      dotCursor,
    });

    expect(await isVacantSkillDirectory(vacant)).toBe(true);
    const restored = await restoreVacantSkillFoldersFromClone({
      clonePath: clone,
      basePath,
    });
    expect(restored).toEqual([
      "dot-cursor/skills/fhub-skill-forge/SKILL.md",
      "dot-cursor/skills/fhub-skill-forge/agents/analyzer.md",
    ]);
    expect(await fs.readFile(path.join(vacant, "SKILL.md"), "utf8")).toBe("# forge\n");
    expect(await fs.readFile(path.join(vacant, "agents", "analyzer.md"), "utf8")).toBe(
      "analyze\n"
    );
    await expect(fs.access(path.join(dotCursor, "skills", "gone", "SKILL.md"))).rejects.toThrow();
    expect(await isVacantSkillDirectory(vacant)).toBe(false);
  });
});
