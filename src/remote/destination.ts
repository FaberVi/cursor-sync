import * as vscode from "vscode";
import type { SyncDestination, SyncState } from "../types.js";

export const DEFAULT_REPO_BRANCH = "main";
export const DEFAULT_REPO_BASE_PATH = "cursor-sync";

export interface DestinationSettings {
  type: "repo";
  repo: string;
  branch: string;
  path: string;
}

export function readDestinationSettings(): DestinationSettings {
  const config = vscode.workspace.getConfiguration("cursorSync");
  return {
    type: "repo",
    repo: (config.get<string>("destination.repo") ?? "").trim(),
    branch:
      (config.get<string>("destination.branch") ?? DEFAULT_REPO_BRANCH).trim() ||
      DEFAULT_REPO_BRANCH,
    path: normalizeBasePath(
      config.get<string>("destination.path") ?? DEFAULT_REPO_BASE_PATH
    ),
  };
}

export function isLegacyGistConfigured(): boolean {
  const config = vscode.workspace.getConfiguration("cursorSync");
  const typeRaw = (config.get<string>("destination.type") ?? "repo").trim();
  return typeRaw === "gist";
}

export function normalizeBasePath(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .trim()
      .replace(/^\/+|\/+$/g, "") || DEFAULT_REPO_BASE_PATH
  );
}

export function parseOwnerRepo(
  repo: string
): { owner: string; repo: string } | undefined {
  const cleaned = repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

export type DestinationSettingsPatch = Partial<{
  repo: string;
  branch: string;
  path: string;
}>;

/** Persist destination fields to global VS Code settings (normalizes path). */
export async function persistDestinationSettings(
  patch: DestinationSettingsPatch
): Promise<DestinationSettings> {
  const config = vscode.workspace.getConfiguration("cursorSync");
  const current = readDestinationSettings();

  if (patch.repo !== undefined) {
    const repo = patch.repo.trim();
    if (repo !== current.repo) {
      await config.update("destination.repo", repo, vscode.ConfigurationTarget.Global);
    }
  }
  if (patch.branch !== undefined) {
    const branch = patch.branch.trim() || DEFAULT_REPO_BRANCH;
    if (branch !== current.branch) {
      await config.update("destination.branch", branch, vscode.ConfigurationTarget.Global);
    }
  }
  if (patch.path !== undefined) {
    const path = normalizeBasePath(patch.path);
    if (path !== current.path) {
      await config.update("destination.path", path, vscode.ConfigurationTarget.Global);
    }
  }

  return readDestinationSettings();
}

export function cloneIdentityKey(dest: {
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
}): string {
  return `${dest.owner}/${dest.repo}@${dest.branch}:${dest.basePath}`;
}

export function applyRepoSettingsToSyncState(
  state: SyncState | undefined,
  settings: DestinationSettings
): SyncState | undefined {
  const parsed = parseOwnerRepo(settings.repo);
  if (!parsed || !state) {
    return state;
  }

  const destination: SyncDestination = {
    type: "repo",
    owner: parsed.owner,
    repo: parsed.repo,
    branch: settings.branch,
    basePath: settings.path,
  };

  const identity = cloneIdentityKey({
    owner: parsed.owner,
    repo: parsed.repo,
    branch: settings.branch,
    basePath: settings.path,
  });
  const identityChanged = state.cloneIdentity !== undefined && state.cloneIdentity !== identity;

  return {
    ...state,
    destination,
    completedFileSync: identityChanged ? false : state.completedFileSync,
    cloneIdentity: identityChanged ? undefined : state.cloneIdentity,
  };
}

export function normalizeSyncStateDestination(
  state: SyncState,
  settings?: DestinationSettings
): SyncState {
  const destSettings = settings ?? readDestinationSettings();
  if (state.destination?.type === "repo" && state.destination.owner && state.destination.repo) {
    return state;
  }
  const parsed = parseOwnerRepo(destSettings.repo);
  if (!parsed) {
    return state;
  }
  return {
    ...state,
    destination: {
      type: "repo",
      owner: parsed.owner,
      repo: parsed.repo,
      branch: destSettings.branch,
      basePath: destSettings.path,
    },
  };
}

export function isRepoDestinationConfigured(): boolean {
  return parseOwnerRepo(readDestinationSettings().repo) !== undefined;
}

export function hasRemoteDestination(state: SyncState | undefined): boolean {
  if (!state) {
    return false;
  }
  const normalized = normalizeSyncStateDestination(state);
  return Boolean(
    normalized.destination?.type === "repo" &&
      normalized.destination.owner &&
      normalized.destination.repo
  );
}

export function destinationFromSettings(
  settings: DestinationSettings
): SyncDestination | undefined {
  const parsed = parseOwnerRepo(settings.repo);
  if (!parsed) {
    return undefined;
  }
  return {
    type: "repo",
    owner: parsed.owner,
    repo: parsed.repo,
    branch: settings.branch,
    basePath: settings.path,
  };
}

export function syncStateIdentity(state: SyncState): string {
  const normalized = normalizeSyncStateDestination(state);
  const d = normalized.destination;
  if (d?.owner && d.repo) {
    return `${d.owner}/${d.repo}@${d.branch ?? DEFAULT_REPO_BRANCH}`;
  }
  return "";
}

export function remoteUrlForState(state: SyncState): string | undefined {
  const normalized = normalizeSyncStateDestination(state);
  const d = normalized.destination;
  if (!d?.owner || !d.repo) {
    return undefined;
  }
  const branch = d.branch || DEFAULT_REPO_BRANCH;
  const base = d.basePath || DEFAULT_REPO_BASE_PATH;
  return `https://github.com/${d.owner}/${d.repo}/tree/${branch}/${base}`;
}

export function buildRepoSyncState(options: {
  previous?: SyncState;
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
  checksums: Record<string, string>;
  direction: "push" | "pull";
  completedFileSync: boolean;
}): SyncState {
  const identity = cloneIdentityKey({
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    basePath: options.basePath,
  });
  return {
    lastSyncTimestamp: new Date().toISOString(),
    lastSyncDirection: options.direction,
    destination: {
      type: "repo",
      owner: options.owner,
      repo: options.repo,
      branch: options.branch,
      basePath: options.basePath,
    },
    localChecksums: options.checksums,
    remoteChecksums: options.checksums,
    completedFileSync: options.completedFileSync,
    cloneIdentity: options.completedFileSync ? identity : options.previous?.cloneIdentity,
  };
}
