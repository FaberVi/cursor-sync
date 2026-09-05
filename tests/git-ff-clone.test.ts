import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const gitIdentity = {
  GIT_AUTHOR_NAME: "Cursor Sync Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Cursor Sync Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function gitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function fileUrl(dir: string): string {
  const posix = dir.replace(/\\/g, "/");
  return posix.startsWith("/") ? `file://${posix}` : `file:///${posix}`;
}

describe("git fast-forward clone", () => {
  let tmp = "";

  afterEach(async () => {
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  it.skipIf(!gitAvailable())("rejects merge --ff-only when histories have diverged", async () => {
    const { runGit } = await import("../src/git-cli.js");
    const { ffMergeFromOrigin, relationToOrigin } = await import("../src/sync-clone.js");

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-ff-"));
    const bare = path.join(tmp, "origin.git");
    const cloneA = path.join(tmp, "a");
    const cloneB = path.join(tmp, "b");

    await runGit({ args: ["init", "--bare", bare] });
    await runGit({ args: ["clone", fileUrl(bare), cloneA] });
    await fs.writeFile(path.join(cloneA, "readme.txt"), "one");
    await runGit({ args: ["add", "readme.txt"], cwd: cloneA });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "one"],
      cwd: cloneA,
      env: gitIdentity,
    });
    await runGit({ args: ["push", "-u", "origin", "HEAD:main"], cwd: cloneA });

    await runGit({ args: ["clone", "-b", "main", fileUrl(bare), cloneB] });

    await fs.writeFile(path.join(cloneA, "readme.txt"), "two");
    await runGit({ args: ["add", "readme.txt"], cwd: cloneA });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "two"],
      cwd: cloneA,
      env: gitIdentity,
    });
    await runGit({ args: ["push", "origin", "HEAD:main"], cwd: cloneA });

    await fs.writeFile(path.join(cloneB, "other.txt"), "local");
    await runGit({ args: ["add", "other.txt"], cwd: cloneB });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "local"],
      cwd: cloneB,
      env: gitIdentity,
    });
    await runGit({ args: ["fetch", "origin"], cwd: cloneB });

    expect(await relationToOrigin(cloneB, "main")).toBe("diverged");
    await expect(ffMergeFromOrigin(cloneB, "main")).rejects.toThrow(/diverged/i);
  });

  it.skipIf(!gitAvailable())("pushClone uses git push without --ff-only and rejects non-fast-forward", async () => {
    const { runGit } = await import("../src/git-cli.js");
    const { pushClone } = await import("../src/sync-clone.js");

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-push-"));
    const bare = path.join(tmp, "origin.git");
    const cloneA = path.join(tmp, "a");
    const cloneB = path.join(tmp, "b");

    await runGit({ args: ["init", "--bare", bare] });
    await runGit({ args: ["clone", fileUrl(bare), cloneA] });
    await fs.writeFile(path.join(cloneA, "readme.txt"), "one");
    await runGit({ args: ["add", "readme.txt"], cwd: cloneA });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "one"],
      cwd: cloneA,
      env: gitIdentity,
    });
    await pushClone({
      clonePath: cloneA,
      branch: "HEAD:main",
      pat: "unused",
      setUpstream: true,
    });

    await runGit({ args: ["clone", "-b", "main", fileUrl(bare), cloneB] });

    await fs.writeFile(path.join(cloneA, "readme.txt"), "two");
    await runGit({ args: ["add", "readme.txt"], cwd: cloneA });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "two"],
      cwd: cloneA,
      env: gitIdentity,
    });
    await pushClone({
      clonePath: cloneA,
      branch: "HEAD:main",
      pat: "unused",
      setUpstream: false,
    });

    await fs.writeFile(path.join(cloneB, "other.txt"), "local");
    await runGit({ args: ["add", "other.txt"], cwd: cloneB });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "local"],
      cwd: cloneB,
      env: gitIdentity,
    });
    await runGit({ args: ["fetch", "origin"], cwd: cloneB });

    await expect(
      pushClone({
        clonePath: cloneB,
        branch: "main",
        pat: "unused",
        setUpstream: false,
      })
    ).rejects.toThrow(/fast-forward only|non-fast-forward|rejected/i);
  });

  it.skipIf(!gitAvailable())("checkoutBranch tracks origin/<branch> when the local branch is missing", async () => {
    const { runGit } = await import("../src/git-cli.js");
    const { checkoutBranch } = await import("../src/sync-clone.js");

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-co-"));
    const bare = path.join(tmp, "origin.git");
    const cloneA = path.join(tmp, "a");
    const cloneB = path.join(tmp, "b");

    await runGit({ args: ["init", "--bare", bare] });
    await runGit({ args: ["clone", fileUrl(bare), cloneA] });
    await fs.writeFile(path.join(cloneA, "readme.txt"), "from-origin");
    await runGit({ args: ["add", "readme.txt"], cwd: cloneA });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "origin"],
      cwd: cloneA,
      env: gitIdentity,
    });
    await runGit({ args: ["push", "-u", "origin", "HEAD:main"], cwd: cloneA });

    await runGit({ args: ["clone", "-b", "main", fileUrl(bare), cloneB] });
    await runGit({ args: ["checkout", "-b", "develop"], cwd: cloneB });
    await fs.writeFile(path.join(cloneB, "readme.txt"), "local-only");
    await runGit({ args: ["add", "readme.txt"], cwd: cloneB });
    await runGit({
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "local"],
      cwd: cloneB,
      env: gitIdentity,
    });
    await runGit({ args: ["branch", "-D", "main"], cwd: cloneB });
    await runGit({ args: ["fetch", "origin"], cwd: cloneB });

    await checkoutBranch(cloneB, "main");
    expect(await fs.readFile(path.join(cloneB, "readme.txt"), "utf8")).toBe("from-origin");
  });
});
