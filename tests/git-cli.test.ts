import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  gitAuthConfigArgs,
  githubHttpsUrl,
  redactGitArgs,
  runGit,
  __resetGitPathCacheForTests,
  __setGitSpawnForTests,
} from "../src/git-cli.js";

describe("git-cli auth", () => {
  it("puts the PAT in http.extraHeader, never in the GitHub URL", () => {
    const pat = "ghp_super_secret_token";
    const args = gitAuthConfigArgs(pat);
    expect(args).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      expect.stringMatching(/^http\.extraHeader=AUTHORIZATION: basic /i),
    ]);
    expect(args.join(" ")).not.toContain(pat);
    expect(githubHttpsUrl("acme", "backup")).toBe("https://github.com/acme/backup.git");
    expect(githubHttpsUrl("acme", "backup")).not.toContain("@");
  });

  it("redacts extraHeader values in logged args", () => {
    const args = [
      ...gitAuthConfigArgs("ghp_secret"),
      "fetch",
      "origin",
    ];
    const redacted = redactGitArgs(args);
    expect(redacted).toContain("http.extraHeader=<redacted>");
    expect(redacted.join(" ")).not.toContain("ghp_secret");
    expect(redacted).toContain("fetch");
  });

  it("refuses git args that embed a token in a GitHub URL", async () => {
    __resetGitPathCacheForTests();
    await expect(
      runGit({
        args: ["clone", "https://x-access-token:ghp_secret@github.com/acme/backup.git"],
      })
    ).rejects.toThrow(/token embedded in a URL/i);
    __resetGitPathCacheForTests();
  });

  it("kills the git child when the command times out", async () => {
    __resetGitPathCacheForTests();
    let killed = false;
    __setGitSpawnForTests((_command, args) => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      child.pid = 4242;
      child.killed = false;
      child.kill = (() => {
        killed = true;
        child.killed = true;
        queueMicrotask(() => child.emit("close", 1));
        return true;
      }) as ChildProcess["kill"];
      if (args[0] === "--version") {
        queueMicrotask(() => child.emit("close", 0));
      }
      return child;
    });
    try {
      await expect(runGit({ args: ["status"], timeoutMs: 30 })).rejects.toThrow(/timed out/i);
      expect(killed).toBe(true);
    } finally {
      __setGitSpawnForTests(undefined);
      __resetGitPathCacheForTests();
    }
  });
});
