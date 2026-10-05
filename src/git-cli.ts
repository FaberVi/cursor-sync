import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import { getLogger } from "./diagnostics.js";
import {
  getSyncAbortSignal,
  killChildProcess,
  registerLiveChildProcess,
  SyncCancelledError,
  throwIfAborted,
} from "./sync-abort.js";

export const GIT_NOT_FOUND_MESSAGE =
  "Git was not found on PATH. Install Git for Windows (https://git-scm.com/download/win) and restart Cursor.";

const WINDOWS_GIT_FALLBACKS = [
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
];

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

let spawnImpl: SpawnLike = spawn;
let cachedGitPath: string | undefined;

export function __setGitSpawnForTests(fn: SpawnLike | undefined): void {
  spawnImpl = fn ?? spawn;
}

export function __resetGitPathCacheForTests(): void {
  cachedGitPath = undefined;
}

export class GitError extends Error {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly args: string[];

  constructor(message: string, opts: {
    code: number;
    stdout: string;
    stderr: string;
    args: string[];
  }) {
    super(message);
    this.name = "GitError";
    this.code = opts.code;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.args = opts.args;
  }
}

export class GitNotFoundError extends Error {
  constructor(message = GIT_NOT_FOUND_MESSAGE) {
    super(message);
    this.name = "GitNotFoundError";
  }
}

export type GitRunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export function gitAuthConfigArgs(pat: string): string[] {
  const token = Buffer.from(`x-access-token:${pat}`, "utf8").toString("base64");
  return [
    "-c",
    "credential.helper=",
    "-c",
    `http.extraHeader=AUTHORIZATION: basic ${token}`,
  ];
}

export function redactGitArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-c" && args[i + 1]?.startsWith("http.extraHeader=")) {
      out.push("-c", "http.extraHeader=<redacted>");
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function looksLikeGithubUrlWithToken(value: string): boolean {
  return /https?:\/\/[^/@]*:.+@github\.com/i.test(value);
}

export function githubHttpsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

export function normalizeGithubRemoteUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export async function resolveGitExecutable(): Promise<string> {
  if (cachedGitPath) {
    return cachedGitPath;
  }

  const candidates = ["git"];
  if (process.platform === "win32") {
    candidates.push("git.exe", ...WINDOWS_GIT_FALLBACKS);
  }

  for (const candidate of candidates) {
    const ok = await probeGit(candidate);
    if (ok) {
      cachedGitPath = candidate;
      return candidate;
    }
  }

  throw new GitNotFoundError();
}

async function probeGit(command: string): Promise<boolean> {
  try {
    if (command.includes("\\") || command.includes("/")) {
      await fs.access(command);
    }
  } catch {
    return false;
  }

  try {
    await runGitProcess(command, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 15_000,
    });
    return true;
  } catch (err) {
    if (err instanceof GitNotFoundError) {
      return false;
    }
    if (err instanceof GitError && err.code === 0) {
      return true;
    }
    return err instanceof GitError === false ? false : err.code === 0;
  }
}

export async function runGit(options: {
  args: string[];
  cwd?: string;
  pat?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<GitRunResult> {
  throwIfAborted();
  const git = await resolveGitExecutable();
  const args = options.pat
    ? [...gitAuthConfigArgs(options.pat), ...options.args]
    : [...options.args];

  if (args.some((a) => looksLikeGithubUrlWithToken(a))) {
    throw new Error("Refusing to run git with a token embedded in a URL.");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "Never",
  };

  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] git ${redactGitArgs(args).join(" ")}`
  );

  return runGitProcess(git, args, {
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs,
  });
}

function runGitProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const signal = getSyncAbortSignal();
    if (signal?.aborted) {
      reject(new SyncCancelledError());
      return;
    }

    let settled = false;
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    registerLiveChildProcess(child);

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const onAbort = (): void => {
      finish(new SyncCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(
          new GitError(`git timed out after ${options.timeoutMs}ms`, {
            code: -1,
            stdout,
            stderr,
            args: [...args],
          })
        );
        killChildProcess(child);
      }, options.timeoutMs);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish(new GitNotFoundError());
        return;
      }
      finish(err);
    });

    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        finish(undefined, { stdout, stderr, code: 0 });
        return;
      }
      const snippet = (stderr || stdout).trim().slice(0, 400);
      finish(
        new GitError(snippet || `git exited with code ${exitCode}`, {
          code: exitCode,
          stdout,
          stderr,
          args: [...args],
        })
      );
    });

    function finish(err?: unknown, ok?: GitRunResult): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
        return;
      }
      resolve(ok!);
    }
  });
}

export async function gitResetHard(cwd: string, ref: string): Promise<void> {
  await runGit({ args: ["reset", "--hard", ref], cwd });
}

export async function gitCleanFd(cwd: string): Promise<void> {
  await runGit({ args: ["clean", "-fd"], cwd });
}

export async function gitRevParse(cwd: string, ref: string): Promise<string> {
  const result = await runGit({ args: ["rev-parse", ref], cwd });
  return result.stdout.trim();
}
