import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("migrateSkillSyncArtifacts", () => {
  const tmpDir = path.join(
    os.tmpdir(),
    "cursor-sync-skill-migrate-" + Date.now()
  );
  const skillsRoot = path.join(tmpDir, "skills");

  beforeEach(async () => {
    await fs.mkdir(skillsRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("promotes skill-snapshot to the real skill name when missing", async () => {
    const workspace = path.join(skillsRoot, "code-review-workspace", "skill-snapshot");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "SKILL.md"), "# code-review\n");
    await fs.writeFile(path.join(workspace, "helper.txt"), "help");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.promoted).toEqual([
      {
        from: "skills/code-review-workspace/skill-snapshot",
        to: "skills/code-review",
      },
    ]);
    expect(result.removed).toContain("skills/code-review-workspace");
    expect(result.recoveredSkillDirs).toContain("skills/code-review");

    const skillMd = await fs.readFile(
      path.join(skillsRoot, "code-review", "SKILL.md"),
      "utf-8"
    );
    expect(skillMd).toBe("# code-review\n");
    expect(
      await fs.readFile(path.join(skillsRoot, "code-review", "helper.txt"), "utf-8")
    ).toBe("help");

    await expect(
      fs.access(path.join(skillsRoot, "code-review-workspace"))
    ).rejects.toThrow();
  });

  it("merges missing files when live skill exists but is incomplete", async () => {
    await fs.mkdir(path.join(skillsRoot, "code-review"), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, "code-review", "SKILL.md"),
      "# minimal\n"
    );

    const workspace = path.join(skillsRoot, "code-review-workspace", "skill-snapshot");
    await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
    await fs.writeFile(path.join(workspace, "SKILL.md"), "# snapshot\n");
    await fs.writeFile(path.join(workspace, "scripts", "run.py"), "print(1)\n");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.promoted.length).toBeGreaterThan(0);
    expect(result.removed).toContain("skills/code-review-workspace");
    expect(
      await fs.readFile(path.join(skillsRoot, "code-review", "SKILL.md"), "utf-8")
    ).toBe("# minimal\n");
    expect(
      await fs.readFile(
        path.join(skillsRoot, "code-review", "scripts", "run.py"),
        "utf-8"
      )
    ).toBe("print(1)\n");
  });

  it("promotes from skill-postedit-backup when skill-snapshot is missing", async () => {
    const backup = path.join(
      skillsRoot,
      "only-backup-workspace",
      "skill-postedit-backup"
    );
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(path.join(backup, "SKILL.md"), "# from backup\n");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.promoted).toEqual([
      {
        from: "skills/only-backup-workspace/skill-postedit-backup",
        to: "skills/only-backup",
      },
    ]);
    expect(result.removed).toContain("skills/only-backup-workspace");
    expect(
      await fs.readFile(path.join(skillsRoot, "only-backup", "SKILL.md"), "utf-8")
    ).toBe("# from backup\n");
  });

  it("prefers the newest artifact source when recovering", async () => {
    const workspace = path.join(skillsRoot, "newer-workspace");
    const oldSnap = path.join(workspace, "skill-snapshot");
    const newSnap = path.join(workspace, "skill-snapshot-grilling");
    await fs.mkdir(oldSnap, { recursive: true });
    await fs.mkdir(newSnap, { recursive: true });
    await fs.writeFile(path.join(oldSnap, "SKILL.md"), "# old\n");
    await fs.writeFile(path.join(newSnap, "SKILL.md"), "# new\n");
    const past = new Date("2020-01-01T00:00:00Z");
    const recent = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(path.join(oldSnap, "SKILL.md"), past, past);
    await fs.utimes(path.join(newSnap, "SKILL.md"), recent, recent);

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    await migrateSkillSyncArtifacts(tmpDir);

    expect(
      await fs.readFile(path.join(skillsRoot, "newer", "SKILL.md"), "utf-8")
    ).toBe("# new\n");
  });

  it("does not overwrite an existing real skill; still removes disposable workspace", async () => {
    await fs.mkdir(path.join(skillsRoot, "grill-me"), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, "grill-me", "SKILL.md"),
      "# live\n"
    );

    const workspace = path.join(skillsRoot, "grill-me-workspace", "skill-snapshot");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "SKILL.md"), "# old snapshot\n");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.removed).toContain("skills/grill-me-workspace");
    expect(
      await fs.readFile(path.join(skillsRoot, "grill-me", "SKILL.md"), "utf-8")
    ).toBe("# live\n");
    await expect(
      fs.access(path.join(skillsRoot, "grill-me-workspace"))
    ).rejects.toThrow();
  });

  it("does not delete active skill-forge workspace with iteration dirs", async () => {
    const workspace = path.join(skillsRoot, "forge-workspace");
    await fs.mkdir(path.join(workspace, "skill-snapshot"), { recursive: true });
    await fs.mkdir(path.join(workspace, "iteration-1", "eval-0"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, "skill-snapshot", "SKILL.md"),
      "# snapshot\n"
    );
    await fs.writeFile(
      path.join(workspace, "iteration-1", "eval-0", "out.txt"),
      "run"
    );

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.promoted).toEqual([
      {
        from: "skills/forge-workspace/skill-snapshot",
        to: "skills/forge",
      },
    ]);
    expect(result.removed).not.toContain("skills/forge-workspace");
    expect(result.removed).toContain("skills/forge-workspace/skill-snapshot");
    expect(
      await fs.readFile(path.join(skillsRoot, "forge", "SKILL.md"), "utf-8")
    ).toBe("# snapshot\n");
    expect(
      await fs.readFile(
        path.join(workspace, "iteration-1", "eval-0", "out.txt"),
        "utf-8"
      )
    ).toBe("run");
    await expect(
      fs.access(path.join(workspace, "skill-snapshot"))
    ).rejects.toThrow();
  });

  it("does not delete workspace with loose files at root", async () => {
    const workspace = path.join(skillsRoot, "meta-workspace");
    await fs.mkdir(path.join(workspace, "skill-snapshot"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "skill-snapshot", "SKILL.md"),
      "# snap\n"
    );
    await fs.writeFile(path.join(workspace, "eval_metadata.json"), "{}\n");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.removed).not.toContain("skills/meta-workspace");
    expect(result.removed).toContain("skills/meta-workspace/skill-snapshot");
    expect(
      await fs.readFile(path.join(workspace, "eval_metadata.json"), "utf-8")
    ).toBe("{}\n");
    expect(
      await fs.readFile(path.join(skillsRoot, "meta", "SKILL.md"), "utf-8")
    ).toBe("# snap\n");
    await expect(
      fs.access(path.join(workspace, "skill-snapshot"))
    ).rejects.toThrow();
  });

  it("does not touch a legitimate skill named *-workspace", async () => {
    const skillDir = path.join(skillsRoot, "my-agent-workspace");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# agent\n");
    await fs.writeFile(path.join(skillDir, "scripts", "run.py"), "print(1)\n");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.promoted).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(
      await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")
    ).toBe("# agent\n");
  });

  it("relocates top-level skills/skill-snapshot instead of deleting it", async () => {
    const bogus = path.join(skillsRoot, "skill-snapshot");
    await fs.mkdir(bogus, { recursive: true });
    await fs.writeFile(path.join(bogus, "SKILL.md"), "# bogus\n");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.removed).toContain("skills/skill-snapshot");
    expect(result.recoveredSkillDirs.some((d) => d.includes("_orphaned-snapshots"))).toBe(
      true
    );
    await expect(fs.access(bogus)).rejects.toThrow();
    const recoveredDir = path.join(
      skillsRoot,
      ...result.recoveredSkillDirs[0]!.split("/").slice(1)
    );
    expect(
      await fs.readFile(path.join(recoveredDir, "SKILL.md"), "utf-8")
    ).toBe("# bogus\n");
  });

  it("merges then removes nested skill-snapshot under real skills", async () => {
    const skillDir = path.join(skillsRoot, "django-vue-bootstrap");
    await fs.mkdir(path.join(skillDir, "skill-snapshot", "scripts"), {
      recursive: true,
    });
    await fs.mkdir(path.join(skillDir, "skill-postedit-backup"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# real\n");
    await fs.writeFile(
      path.join(skillDir, "skill-snapshot", "scripts", "extra.py"),
      "x\n"
    );
    await fs.writeFile(
      path.join(skillDir, "skill-postedit-backup", "SKILL.md"),
      "# backup\n"
    );

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.removed).toEqual(
      expect.arrayContaining([
        "skills/django-vue-bootstrap/skill-snapshot",
        "skills/django-vue-bootstrap/skill-postedit-backup",
      ])
    );
    expect(
      await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")
    ).toBe("# real\n");
    expect(
      await fs.readFile(path.join(skillDir, "scripts", "extra.py"), "utf-8")
    ).toBe("x\n");
  });

  it("is a no-op when skills directory is clean", async () => {
    await fs.mkdir(path.join(skillsRoot, "coding"), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, "coding", "SKILL.md"), "ok");

    const { migrateSkillSyncArtifacts } = await import(
      "../src/skill-artifacts-migrate.js"
    );
    const result = await migrateSkillSyncArtifacts(tmpDir);

    expect(result.promoted).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.recoveredSkillDirs).toEqual([]);
  });
});

describe("listSkillArtifactSyncKeys", () => {
  it("selects only skill-creator artifact manifest keys", async () => {
    const { listSkillArtifactSyncKeys } = await import("../src/paths.js");
    const keys = listSkillArtifactSyncKeys({
      "dot-cursor/skills/coding/SKILL.md": {},
      "dot-cursor/skills/foo-workspace/skill-snapshot/SKILL.md": {},
      "dot-cursor/skills/foo-workspace/iteration-1/out.txt": {},
      "dot-cursor/skills/my-agent-workspace/SKILL.md": {},
      "cursor-user/settings.json": {},
    });
    expect(keys.sort()).toEqual(
      [
        "dot-cursor/skills/foo-workspace/iteration-1/out.txt",
        "dot-cursor/skills/foo-workspace/skill-snapshot/SKILL.md",
      ].sort()
    );
  });
});
