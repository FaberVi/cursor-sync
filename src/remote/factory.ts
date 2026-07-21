import type * as vscode from "vscode";
import type { SyncState } from "../types.js";
import {
  destinationFromSettings,
  normalizeSyncStateDestination,
  parseOwnerRepo,
  readDestinationSettings,
} from "./destination.js";
import { GistBackend } from "./gist-backend.js";
import { RepoBackend } from "./repo-backend.js";
import type { RemoteSyncBackend } from "./types.js";

/**
 * Create a remote backend from settings + sync state.
 * Returns undefined when repo destination is selected but owner/repo is missing.
 */
export function createRemoteBackend(
  _context: vscode.ExtensionContext,
  token: string,
  syncState?: SyncState
): RemoteSyncBackend | undefined {
  const settings = readDestinationSettings();
  const normalized = syncState
    ? normalizeSyncStateDestination(syncState, settings)
    : undefined;

  if (settings.type === "repo") {
    const fromState = normalized?.destination?.type === "repo" ? normalized.destination : undefined;
    const parsed =
      fromState?.owner && fromState?.repo
        ? { owner: fromState.owner, repo: fromState.repo }
        : parseOwnerRepo(settings.repo);
    if (!parsed) {
      return undefined;
    }
    return new RepoBackend({
      pat: token,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: fromState?.branch || settings.branch,
      basePath: fromState?.basePath || settings.path,
    });
  }

  const gistId =
    normalized?.destination?.gistId ||
    normalized?.gistId ||
    undefined;
  return new GistBackend(token, gistId || undefined);
}

export function buildSyncStateAfterWrite(
  previous: SyncState | undefined,
  backend: RemoteSyncBackend,
  writeId: string,
  checksums: Record<string, string>,
  direction: "push" | "pull"
): SyncState {
  const settings = readDestinationSettings();
  let destination = destinationFromSettings(
    settings,
    backend.type === "gist" ? writeId : previous?.gistId
  );

  if (backend instanceof RepoBackend) {
    destination = {
      type: "repo",
      owner: backend.getOwner(),
      repo: backend.getRepo(),
      branch: backend.getBranch(),
      basePath: backend.getBasePath(),
    };
  } else if (backend instanceof GistBackend) {
    destination = {
      type: "gist",
      gistId: writeId,
    };
  }

  return {
    lastSyncTimestamp: new Date().toISOString(),
    lastSyncDirection: direction,
    gistId: backend.type === "gist" ? writeId : previous?.gistId || "",
    destination,
    localChecksums: checksums,
    remoteChecksums: checksums,
  };
}

export { GistBackend, RepoBackend };
