import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("rollback", () => {
  const tmpDir = path.join(os.tmpdir(), "cursor-sync-rollback-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ensureParentDirectory creates missing parent directories", async () => {
    const { ensureParentDirectory } = await import("../src/rollback.js");
    const filePath = path.join(tmpDir, "nested", "dir", "file.md");
    await ensureParentDirectory(filePath);
    await fs.writeFile(filePath, "ok", "utf-8");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("ok");
  });

  it("ensureParentDirectory replaces broken symlink/junction parent", async () => {
    if (process.platform === "win32") {
      const linkPath = path.join(tmpDir, "broken-link");
      await fs.symlink(path.join(tmpDir, "missing-target"), linkPath, "junction");
      const filePath = path.join(linkPath, "SKILL.md");
      const { ensureParentDirectory } = await import("../src/rollback.js");
      await ensureParentDirectory(filePath);
      await fs.writeFile(filePath, "skill", "utf-8");
      const stat = await fs.lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(filePath, "utf-8")).toBe("skill");
      return;
    }

    const linkPath = path.join(tmpDir, "broken-link");
    await fs.symlink(path.join(tmpDir, "missing-target"), linkPath);
    const filePath = path.join(linkPath, "SKILL.md");
    const { ensureParentDirectory } = await import("../src/rollback.js");
    await ensureParentDirectory(filePath);
    await fs.writeFile(filePath, "skill", "utf-8");
    expect(await fs.readFile(filePath, "utf-8")).toBe("skill");
  });

  it("unlinkCreatedFiles removes new files and leftover tmp", async () => {
    const created = path.join(tmpDir, "new-settings.json");
    const tmp = created + ".tmp";
    await fs.writeFile(created, "new", "utf-8");
    await fs.writeFile(tmp, "partial", "utf-8");
    const { unlinkCreatedFiles } = await import("../src/rollback.js");
    const n = await unlinkCreatedFiles([created]);
    expect(n).toBe(1);
    await expect(fs.access(created)).rejects.toThrow();
    await expect(fs.access(tmp)).rejects.toThrow();
  });

  it("backupSkillDirectories copies leftovers and restoreSkillDirectories replaces the tree", async () => {
    const skillDir = path.join(tmpDir, "skills", "foo");
    await fs.mkdir(path.join(skillDir, "node_modules", "leftpad"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "old\n", "utf-8");
    await fs.writeFile(
      path.join(skillDir, "node_modules", "leftpad", "index.js"),
      "leftover\n",
      "utf-8"
    );
    const backupDir = path.join(tmpDir, "backup");
    const { backupSkillDirectories, restoreSkillDirectories, pathIsInsideDirectory } =
      await import("../src/rollback.js");
    const restores = await backupSkillDirectories([skillDir], backupDir);
    expect(restores).toHaveLength(1);
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "remote\n", "utf-8");
    await fs.writeFile(path.join(skillDir, "new-remote.py"), "new\n", "utf-8");
    const restored = await restoreSkillDirectories(restores);
    expect(restored).toHaveLength(1);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("old\n");
    expect(
      await fs.readFile(path.join(skillDir, "node_modules", "leftpad", "index.js"), "utf-8")
    ).toBe("leftover\n");
    await expect(fs.access(path.join(skillDir, "new-remote.py"))).rejects.toThrow();
    expect(pathIsInsideDirectory(path.join(skillDir, "SKILL.md"), skillDir)).toBe(true);
    expect(
      pathIsInsideDirectory(path.join(tmpDir, "skills", "foo-workspace", "x"), skillDir)
    ).toBe(false);
  });
});
