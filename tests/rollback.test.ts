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
});
