import * as vscode from "vscode";
import type { SyncDestination, SyncDestinationType, SyncState } from "../types.js";

export const DEFAULT_REPO_BRANCH = "main";
export const DEFAULT_REPO_BASE_PATH = "cursor-sync";

export interface DestinationSettings {
  type: SyncDestinationType;
  repo: string;
  branch: string;
  path: string;
}

export function readDestinationSettings(): DestinationSettings {
  const config = vscode.workspace.getConfiguration("cursorSync");
  const typeRaw = config.get<string>("destination.type") ?? "gist";
  const type: SyncDestinationType = typeRaw === "repo" ? "repo" : "gist";
  return {
    type,
    repo: (config.get<string>("destination.repo") ?? "").trim(),
    branch: (config.get<string>("destination.branch") ?? DEFAULT_REPO_BRANCH).trim() || DEFAULT_REPO_BRANCH,
    path: normalizeBasePath(
      config.get<string>("destination.path") ?? DEFAULT_REPO_BASE_PATH
    ),
  };
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
  const cleaned = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

export type DestinationSettingsPatch = Partial<{
  type: string;
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

  if (patch.type !== undefined) {
    const type: SyncDestinationType = patch.type === "repo" ? "repo" : "gist";
    if (type !== current.type) {
      await config.update("destination.type", type, vscode.ConfigurationTarget.Global);
    }
  }
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

/**
 * Replace sync-state repo destination with the current settings
 * (owner/repo/branch/basePath). Used when reconnecting via Connect repository.
 */
export function applyRepoSettingsToSyncState(
  state: SyncState | undefined,
  settings: DestinationSettings
): SyncState | undefined {
  if (settings.type !== "repo") {
    return state;
  }
  const parsed = parseOwnerRepo(settings.repo);
  if (!parsed) {
    return state;
  }

  const destination: SyncDestination = {
    type: "repo",
    owner: parsed.owner,
    repo: parsed.repo,
    branch: settings.branch,
    basePath: settings.path,
    gistId: state?.gistId || state?.destination?.gistId || undefined,
  };

  if (!state) {
    return undefined;
  }

  return {
    ...state,
    destination,
  };
}

/** Ensure SyncState.destination is populated from legacy gistId / settings. */
export function normalizeSyncStateDestination(
  state: SyncState,
  settings?: DestinationSettings
): SyncState {
  const destSettings = settings ?? readDestinationSettings();
  if (state.destination?.type) {
    return state;
  }
  if (destSettings.type === "repo") {
    const parsed = parseOwnerRepo(destSettings.repo);
    if (parsed) {
      return {
        ...state,
        destination: {
          type: "repo",
          owner: parsed.owner,
          repo: parsed.repo,
          branch: destSettings.branch,
          basePath: destSettings.path,
          gistId: state.gistId || undefined,
        },
      };
    }
  }
  if (state.gistId) {
    return {
      ...state,
      destination: {
        type: "gist",
        gistId: state.gistId,
      },
    };
  }
  return state;
}

export function hasRemoteDestination(state: SyncState | undefined): boolean {
  if (!state) {
    return false;
  }
  const normalized = normalizeSyncStateDestination(state);
  if (normalized.destination?.type === "repo") {
    return Boolean(normalized.destination.owner && normalized.destination.repo);
  }
  return Boolean(normalized.gistId || normalized.destination?.gistId);
}

export function destinationFromSettings(
  settings: DestinationSettings,
  gistId?: string
): SyncDestination | undefined {
  if (settings.type === "repo") {
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
      gistId,
    };
  }
  if (gistId) {
    return { type: "gist", gistId };
  }
  return { type: "gist" };
}

export function syncStateIdentity(state: SyncState): string {
  const normalized = normalizeSyncStateDestination(state);
  if (normalized.destination?.type === "repo") {
    const d = normalized.destination;
    return `${d.owner}/${d.repo}@${d.branch ?? DEFAULT_REPO_BRANCH}`;
  }
  return normalized.destination?.gistId || normalized.gistId || "";
}

export function remoteUrlForState(state: SyncState): string | undefined {
  const normalized = normalizeSyncStateDestination(state);
  if (normalized.destination?.type === "repo") {
    const d = normalized.destination;
    if (!d.owner || !d.repo) {
      return undefined;
    }
    const branch = d.branch || DEFAULT_REPO_BRANCH;
    const base = d.basePath || DEFAULT_REPO_BASE_PATH;
    return `https://github.com/${d.owner}/${d.repo}/tree/${branch}/${base}`;
  }
  const gistId = normalized.destination?.gistId || normalized.gistId;
  return gistId ? `https://gist.github.com/${gistId}` : undefined;
}
