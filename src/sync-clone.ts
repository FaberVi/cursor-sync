import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
  GitError,
  githubHttpsUrl,
  gitCleanFd,
  gitResetHard,
  gitRevParse,
  normalizeGithubRemoteUrl,
  runGit,
} from "./git-cli.js";
import { throwIfAborted } from "./sync-abort.js";
import {
  DEFAULT_REPO_BASE_PATH,
  DEFAULT_REPO_BRANCH,
  cloneIdentityKey,
  parseOwnerRepo,
  readDestinationSettings,
} from "./remote/destination.js";
import { getLogger } from "./diagnostics.js";
import { loadSyncState, saveSyncState } from "./diagnostics.js";

export const SYNC_CLONE_DIR = "sync-repo";

export type RepoIdentity = {
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
};

export type GitRelation = "equal" | "ahead" | "behind" | "diverged" | "empty";

export type EnsuredClone = {
  clonePath: string;
  identity: RepoIdentity;
  empty: boolean;
};

export function getSyncClonePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, SYNC_CLONE_DIR);
}

export function readRepoIdentity(): RepoIdentity | undefined {
  const settings = readDestinationSettings();
  const parsed = parseOwnerRepo(settings.repo);
  if (!parsed) {
    return undefined;
  }
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    branch: settings.branch || DEFAULT_REPO_BRANCH,
    basePath: settings.path || DEFAULT_REPO_BASE_PATH,
  };
}

export async function removeSyncClone(context: vscode.ExtensionContext): Promise<void> {
  const clonePath = getSyncClonePath(context);
  await fs.rm(clonePath, { recursive: true, force: true });
}

export async function clearCompletedFileSyncOnIdentityChange(
  context: vscode.ExtensionContext,
  identity: RepoIdentity
): Promise<void> {
  const state = await loadSyncState(context);
  if (!state) {
    return;
  }
  const nextKey = cloneIdentityKey(identity);
  if (state.cloneIdentity && state.cloneIdentity !== nextKey) {
    await saveSyncState(context, {
      ...state,
      completedFileSync: false,
      cloneIdentity: undefined,
    });
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function gitDirExists(clonePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(clonePath, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

async function remoteLsHeads(
  identity: RepoIdentity,
  pat: string
): Promise<string[]> {
  const url = githubHttpsUrl(identity.owner, identity.repo);
  const result = await runGit({
    args: ["ls-remote", "--heads", url],
    pat,
    timeoutMs: 60_000,
  });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function configureCloneLocal(clonePath: string): Promise<void> {
  await runGit({ args: ["config", "core.autocrlf", "false"], cwd: clonePath });
}

async function setSparseCheckout(clonePath: string, basePath: string): Promise<void> {
  await runGit({ args: ["sparse-checkout", "set", "--cone", basePath], cwd: clonePath });
}

async function originUrl(clonePath: string): Promise<string | undefined> {
  try {
    const result = await runGit({ args: ["remote", "get-url", "origin"], cwd: clonePath });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Exported for tests. Prefers an existing local branch; otherwise tracks origin/<branch>. */
export async function checkoutBranch(
  clonePath: string,
  branch: string,
  pat?: string
): Promise<void> {
  try {
    await runGit({ args: ["checkout", branch], cwd: clonePath, pat });
    return;
  } catch {
    // Local branch missing — do not `checkout -B` from whatever HEAD is.
  }
  try {
    await gitRevParse(clonePath, `origin/${branch}`);
    await runGit({
      args: ["checkout", "-B", branch, `origin/${branch}`],
      cwd: clonePath,
      pat,
    });
  } catch {
    await runGit({ args: ["checkout", "-B", branch], cwd: clonePath, pat });
  }
}

export async function fetchOrigin(clonePath: string, pat: string): Promise<void> {
  await runGit({
    args: ["fetch", "origin"],
    cwd: clonePath,
    pat,
    timeoutMs: 120_000,
  });
}

export async function currentHeadSha(clonePath: string): Promise<string | undefined> {
  try {
    return await gitRevParse(clonePath, "HEAD");
  } catch {
    return undefined;
  }
}

export async function resetCloneWorktree(clonePath: string): Promise<void> {
  const sha = await currentHeadSha(clonePath);
  if (sha) {
    await gitResetHard(clonePath, "HEAD");
  }
  try {
    await gitCleanFd(clonePath);
  } catch {
    // empty repo has nothing to clean
  }
}

export async function relationToOrigin(
  clonePath: string,
  branch: string
): Promise<GitRelation> {
  const head = await currentHeadSha(clonePath);
  let originSha: string | undefined;
  try {
    originSha = await gitRevParse(clonePath, `origin/${branch}`);
  } catch {
    originSha = undefined;
  }

  if (!head && !originSha) {
    return "empty";
  }
  if (!originSha) {
    return "ahead";
  }
  if (!head) {
    return "behind";
  }
  if (head === originSha) {
    return "equal";
  }

  let base: string;
  try {
    const result = await runGit({
      args: ["merge-base", "HEAD", `origin/${branch}`],
      cwd: clonePath,
    });
    base = result.stdout.trim();
  } catch {
    return "diverged";
  }

  if (base === originSha) {
    return "ahead";
  }
  if (base === head) {
    return "behind";
  }
  return "diverged";
}

export async function ffMergeFromOrigin(
  clonePath: string,
  branch: string
): Promise<void> {
  throwIfAborted();
  const relation = await relationToOrigin(clonePath, branch);
  if (relation === "equal" || relation === "ahead" || relation === "empty") {
    return;
  }
  if (relation === "diverged") {
    throw new Error(
      "Local clone and origin have diverged. Reset to remote or fix the clone manually."
    );
  }
  await runGit({
    args: ["merge", "--ff-only", `origin/${branch}`],
    cwd: clonePath,
  });
}

export async function resetHardToOrigin(
  clonePath: string,
  branch: string,
  pat: string
): Promise<void> {
  await fetchOrigin(clonePath, pat);
  await gitResetHard(clonePath, `origin/${branch}`);
  await gitCleanFd(clonePath);
}

export async function hasNestedSyncFiles(
  clonePath: string,
  basePath: string
): Promise<boolean> {
  const roots = [
    path.join(clonePath, ...basePath.split("/"), "cursor-user"),
    path.join(clonePath, ...basePath.split("/"), "dot-cursor"),
  ];
  for (const root of roots) {
    try {
      const files = await listFilesRecursive(root);
      if (files.length > 0) {
        return true;
      }
    } catch {
      // missing dir
    }
  }
  return false;
}

async function listFilesRecursive(absDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          continue;
        }
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(absDir);
  return files;
}

async function initEmptyClone(
  clonePath: string,
  identity: RepoIdentity
): Promise<void> {
  await fs.mkdir(clonePath, { recursive: true });
  await runGit({ args: ["init", "-b", identity.branch], cwd: clonePath });
  await runGit({
    args: ["remote", "add", "origin", githubHttpsUrl(identity.owner, identity.repo)],
    cwd: clonePath,
  });
  await configureCloneLocal(clonePath);
}

async function cloneNonEmpty(
  clonePath: string,
  identity: RepoIdentity,
  pat: string
): Promise<void> {
  const parent = path.dirname(clonePath);
  await fs.mkdir(parent, { recursive: true });
  await runGit({
    args: [
      "clone",
      "--filter=blob:none",
      "--sparse",
      githubHttpsUrl(identity.owner, identity.repo),
      clonePath,
    ],
    pat,
    timeoutMs: 180_000,
  });
  await configureCloneLocal(clonePath);
  await setSparseCheckout(clonePath, identity.basePath);
  await checkoutBranch(clonePath, identity.branch, pat);
}

function originMatches(url: string | undefined, identity: RepoIdentity): boolean {
  if (!url) {
    return false;
  }
  const expected = normalizeGithubRemoteUrl(githubHttpsUrl(identity.owner, identity.repo));
  return normalizeGithubRemoteUrl(url) === expected;
}

export async function ensureSyncClone(
  context: vscode.ExtensionContext,
  pat: string
): Promise<EnsuredClone> {
  const identity = readRepoIdentity();
  if (!identity) {
    throw new Error("Repository destination is not configured (owner/name).");
  }

  await clearCompletedFileSyncOnIdentityChange(context, identity);

  const clonePath = getSyncClonePath(context);
  const logger = getLogger();
  const heads = await remoteLsHeads(identity, pat);
  const empty = heads.length === 0;

  const hasGit = await gitDirExists(clonePath);
  const existingOrigin = hasGit ? await originUrl(clonePath) : undefined;
  const mustReclone = !hasGit || !originMatches(existingOrigin, identity);

  if (mustReclone) {
    if (await dirExists(clonePath)) {
      logger.appendLine(
        `[${new Date().toISOString()}] Replacing sync clone at ${clonePath}`
      );
      await fs.rm(clonePath, { recursive: true, force: true });
    }
    const state = await loadSyncState(context);
    if (state?.completedFileSync) {
      await saveSyncState(context, {
        ...state,
        completedFileSync: false,
        cloneIdentity: undefined,
      });
    }
    if (empty) {
      await initEmptyClone(clonePath, identity);
      return { clonePath, identity, empty: true };
    }
    await cloneNonEmpty(clonePath, identity, pat);
    return { clonePath, identity, empty: false };
  }

  await configureCloneLocal(clonePath);

  if (empty) {
    return { clonePath, identity, empty: true };
  }

  await fetchOrigin(clonePath, pat);
  await setSparseCheckout(clonePath, identity.basePath);
  await checkoutBranch(clonePath, identity.branch, pat);
  return { clonePath, identity, empty: false };
}

export async function commitCloneChanges(options: {
  clonePath: string;
  basePath: string;
  userName: string;
  userEmail: string;
}): Promise<boolean> {
  throwIfAborted();
  await runGit({
    args: ["add", "-A", "--", options.basePath],
    cwd: options.clonePath,
  });
  const status = await runGit({
    args: ["status", "--porcelain", "--", options.basePath],
    cwd: options.clonePath,
  });
  if (!status.stdout.trim()) {
    return false;
  }
  const host = os.hostname();
  const message = `cursor-sync: sync from ${host}`;
  await runGit({
    args: [
      "-c",
      `user.name=${options.userName}`,
      "-c",
      `user.email=${options.userEmail}`,
      "commit",
      "-m",
      message,
    ],
    cwd: options.clonePath,
  });
  return true;
}

function isNonFastForwardPush(err: GitError): boolean {
  const text = `${err.message}\n${err.stderr}\n${err.stdout}`;
  return /non-fast-forward|\[rejected\]/i.test(text);
}

export async function pushClone(options: {
  clonePath: string;
  branch: string;
  pat: string;
  setUpstream: boolean;
}): Promise<void> {
  throwIfAborted();
  // git push has no --ff-only (that flag is merge/pull). Default push already
  // refuses non-fast-forward updates; never pass --force.
  const args = options.setUpstream
    ? ["push", "-u", "origin", options.branch]
    : ["push", "origin", options.branch];
  try {
    await runGit({
      args,
      cwd: options.clonePath,
      pat: options.pat,
      timeoutMs: 180_000,
    });
  } catch (err) {
    if (err instanceof GitError && isNonFastForwardPush(err)) {
      throw new Error(
        `git push rejected (fast-forward only): ${err.message}`
      );
    }
    throw err;
  }
}

export function divergedMessage(): string {
  return "Local clone and origin have diverged. Use Reset to remote, or open the clone and fix git manually. Force-push is not available.";
}

export function originAheadMessage(): string {
  return "Origin is ahead of this machine. Pull first (this will overwrite local Cursor files that are in the sync set).";
}
