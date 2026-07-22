import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("paths", () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env = { ...originalEnv };
  });

  describe("resolveSyncRoots", () => {
    it("resolves Windows paths", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      process.env["APPDATA"] = "C:\\Users\\test\\AppData\\Roaming";
      process.env["USERPROFILE"] = "C:\\Users\\test";

      const roots = resolveSyncRoots("win32");
      expect(roots.cursorUser).toBe(
        path.join("C:\\Users\\test\\AppData\\Roaming", "Cursor", "User")
      );
      expect(roots.dotCursor).toBe(path.join("C:\\Users\\test", ".cursor"));
    });

    it("resolves macOS paths", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      const home = os.homedir();

      const roots = resolveSyncRoots("darwin");
      expect(roots.cursorUser).toBe(
        path.join(home, "Library", "Application Support", "Cursor", "User")
      );
      expect(roots.dotCursor).toBe(path.join(home, ".cursor"));
    });

    it("resolves Linux paths with default XDG", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      delete process.env["XDG_CONFIG_HOME"];
      const home = os.homedir();

      const roots = resolveSyncRoots("linux");
      expect(roots.cursorUser).toBe(
        path.join(home, ".config", "Cursor", "User")
      );
      expect(roots.dotCursor).toBe(path.join(home, ".cursor"));
    });

    it("resolves Linux paths with custom XDG_CONFIG_HOME", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      process.env["XDG_CONFIG_HOME"] = "/custom/config";

      const roots = resolveSyncRoots("linux");
      expect(roots.cursorUser).toBe(
        path.join("/custom/config", "Cursor", "User")
      );
    });
  });

  describe("syncKeyToGistFileName / gistFileNameToSyncKey", () => {
    it("converts slashes to double dashes", async () => {
      const { syncKeyToGistFileName } = await import("../src/paths.js");
      expect(syncKeyToGistFileName("cursor-user/settings.json")).toBe(
        "cursor-user--settings.json"
      );
      expect(syncKeyToGistFileName("dot-cursor/skills/coding/template.txt")).toBe(
        "dot-cursor--skills--coding--template.txt"
      );
    });

    it("converts double dashes back to slashes", async () => {
      const { gistFileNameToSyncKey } = await import("../src/paths.js");
      expect(gistFileNameToSyncKey("cursor-user--settings.json")).toBe(
        "cursor-user/settings.json"
      );
      expect(gistFileNameToSyncKey("dot-cursor--skills--coding--template.txt")).toBe(
        "dot-cursor/skills/coding/template.txt"
      );
    });
  });

  describe("enumerateSyncFiles", () => {
    const tmpDir = path.join(os.tmpdir(), "cursor-sync-test-paths-" + Date.now());

    beforeEach(async () => {
      const cursorUser = path.join(tmpDir, "cursorUser");
      const dotCursor = path.join(tmpDir, "dotCursor");

      await fs.mkdir(path.join(cursorUser, "snippets"), { recursive: true });
      await fs.mkdir(path.join(cursorUser, "vsix"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "rules"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "skills", "coding"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "extensions"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "logs"), { recursive: true });

      await fs.writeFile(path.join(cursorUser, "settings.json"), "{}");
      await fs.writeFile(path.join(cursorUser, "keybindings.json"), "[]");
      await fs.writeFile(
        path.join(cursorUser, "snippets", "ts.json"),
        "{}"
      );
      await fs.writeFile(path.join(cursorUser, "vsix", "sample.vsix"), "PK\u0003\u0004");
      await fs.writeFile(
        path.join(dotCursor, "rules", "test.mdc"),
        "rule"
      );
      await fs.writeFile(
        path.join(dotCursor, "skills", "coding", "SKILL.md"),
        "skill"
      );
      await fs.writeFile(
        path.join(dotCursor, "skills", "coding", "template.txt"),
        "template"
      );
      await fs.writeFile(
        path.join(dotCursor, "extensions", "ext.json"),
        "{}"
      );
      await fs.writeFile(path.join(dotCursor, "logs", "app.log"), "log");
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("includes matching files and excludes denylisted directories", async () => {
      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).toContain("cursor-user/settings.json");
      expect(keys).toContain("cursor-user/keybindings.json");
      expect(keys).toContain("cursor-user/snippets/ts.json");
      expect(keys).toContain("cursor-user/vsix/sample.vsix");
      expect(keys).toContain("dot-cursor/rules/test.mdc");
      expect(keys).toContain("dot-cursor/skills/coding/SKILL.md");
      expect(keys).toContain("dot-cursor/skills/coding/template.txt");

      expect(keys).not.toContain("dot-cursor/extensions/ext.json");
      expect(keys).not.toContain("dot-cursor/logs/app.log");
    });

    it("excludes nested __pycache__ and .pyc files", async () => {
      const pycache = path.join(tmpDir, "dotCursor", "skills", "coding", "__pycache__");
      await fs.mkdir(pycache, { recursive: true });
      await fs.writeFile(path.join(pycache, "mod.cpython-313.pyc"), Buffer.from([0x16, 0x0d]));
      await fs.writeFile(
        path.join(tmpDir, "dotCursor", "skills", "coding", "helper.pyc"),
        Buffer.from([0x16, 0x0d])
      );

      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).not.toContain(
        "dot-cursor/skills/coding/__pycache__/mod.cpython-313.pyc"
      );
      expect(keys).not.toContain("dot-cursor/skills/coding/helper.pyc");
      expect(keys).toContain("dot-cursor/skills/coding/SKILL.md");
    });

    it("excludes files exceeding max size", async () => {
      const largePath = path.join(tmpDir, "cursorUser", "settings.json");
      const largeContent = Buffer.alloc(600 * 1024, "x");
      await fs.writeFile(largePath, largeContent);

      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).not.toContain("cursor-user/settings.json");
    });

    it("allows .vsix files larger than maxFileSizeKB", async () => {
      await fs.mkdir(path.join(tmpDir, "cursorUser", "vsix"), { recursive: true });
      const vsixPath = path.join(tmpDir, "cursorUser", "vsix", "big.vsix");
      await fs.writeFile(vsixPath, Buffer.alloc(600 * 1024, "y"));

      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).toContain("cursor-user/vsix/big.vsix");
    });

    it("excludes skill-creator workspace snapshots and backups", async () => {
      const workspaceRoot = path.join(tmpDir, "dotCursor", "skills");
      await fs.mkdir(
        path.join(workspaceRoot, "my-skill-workspace", "skill-snapshot"),
        { recursive: true }
      );
      await fs.mkdir(
        path.join(workspaceRoot, "foo-workspace", "skill-snapshot-grilling"),
        { recursive: true }
      );
      await fs.mkdir(
        path.join(workspaceRoot, "bar-workspace", "skill-postedit-backup"),
        { recursive: true }
      );
      await fs.mkdir(
        path.join(workspaceRoot, "my-agent-workspace", "scripts"),
        { recursive: true }
      );
      await fs.writeFile(
        path.join(workspaceRoot, "my-skill-workspace", "skill-snapshot", "SKILL.md"),
        "snapshot"
      );
      await fs.writeFile(
        path.join(workspaceRoot, "foo-workspace", "skill-snapshot-grilling", "SKILL.md"),
        "grilling"
      );
      await fs.writeFile(
        path.join(workspaceRoot, "bar-workspace", "skill-postedit-backup", "SKILL.md"),
        "backup"
      );
      await fs.writeFile(
        path.join(workspaceRoot, "my-agent-workspace", "SKILL.md"),
        "agent"
      );
      await fs.writeFile(
        path.join(workspaceRoot, "my-agent-workspace", "scripts", "run.py"),
        "print(1)\n"
      );

      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).toContain("dot-cursor/skills/coding/SKILL.md");
      expect(keys).toContain("dot-cursor/skills/my-agent-workspace/SKILL.md");
      expect(keys).toContain("dot-cursor/skills/my-agent-workspace/scripts/run.py");
      expect(keys).not.toContain(
        "dot-cursor/skills/my-skill-workspace/skill-snapshot/SKILL.md"
      );
      expect(keys).not.toContain(
        "dot-cursor/skills/foo-workspace/skill-snapshot-grilling/SKILL.md"
      );
      expect(keys).not.toContain(
        "dot-cursor/skills/bar-workspace/skill-postedit-backup/SKILL.md"
      );
    });
  });

  describe("isSkillSyncArtifact / isExcludedSyncKey", () => {
    it("detects workspace and snapshot artifact paths", async () => {
      const { isSkillSyncArtifact } = await import("../src/paths.js");
      expect(isSkillSyncArtifact("skills/coding/SKILL.md")).toBe(false);
      expect(
        isSkillSyncArtifact("skills/my-skill-workspace/skill-snapshot/SKILL.md")
      ).toBe(true);
      expect(
        isSkillSyncArtifact("skills/foo-workspace/skill-snapshot-grilling/SKILL.md")
      ).toBe(true);
      expect(
        isSkillSyncArtifact("skills/bar-workspace/skill-postedit-backup/SKILL.md")
      ).toBe(true);
      expect(
        isSkillSyncArtifact("skills/coding/skill-snapshot/SKILL.md")
      ).toBe(true);
      expect(
        isSkillSyncArtifact("skills/foo-workspace/iteration-1/out.txt")
      ).toBe(true);
      expect(isSkillSyncArtifact("skills/my-agent-workspace/SKILL.md")).toBe(
        false
      );
      expect(
        isSkillSyncArtifact("skills/my-agent-workspace/scripts/run.py")
      ).toBe(false);
      expect(isSkillSyncArtifact("skills/skill-snapshot/SKILL.md")).toBe(true);
    });

    it("excludes skill artifact sync keys from pull/import restore", async () => {
      const { isExcludedSyncKey } = await import("../src/paths.js");
      expect(isExcludedSyncKey("dot-cursor/skills/coding/SKILL.md", [])).toBe(false);
      expect(
        isExcludedSyncKey(
          "dot-cursor/skills/my-skill-workspace/skill-snapshot/SKILL.md",
          []
        )
      ).toBe(true);
      expect(
        isExcludedSyncKey(
          "dot-cursor/skills/foo-workspace/skill-snapshot-grilling/SKILL.md",
          []
        )
      ).toBe(true);
      expect(
        isExcludedSyncKey(
          "dot-cursor/skills/bar-workspace/skill-postedit-backup/SKILL.md",
          []
        )
      ).toBe(true);
      expect(
        isExcludedSyncKey("dot-cursor/skills/my-agent-workspace/SKILL.md", [])
      ).toBe(false);
      expect(isExcludedSyncKey("cursor-user/settings.json", [])).toBe(false);
      expect(
        isExcludedSyncKey("dot-cursor/skills/coding/notes.md", ["skills/**/notes.md"])
      ).toBe(true);
    });
  });
});
