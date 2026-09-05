import type { ApiResult, SyncDestination, SyncDestinationType, SyncState } from "../types.js";

export interface RemoteSnapshot {
  id: string;
  htmlUrl: string;
  /** Flat remote file name → full text content (same names as Gist). */
  files: Record<string, string>;
  /**
   * All flat file names on the remote, including files whose content was
   * not downloaded (when {@link RemoteSnapshotOptions.onlyFiles} is set).
   * When omitted, callers should treat `Object.keys(files)` as the full list.
   */
  allFileNames?: string[];
}

export interface RemoteSnapshotOptions {
  /**
   * When set, only these flat file names are downloaded into `files`.
   * `allFileNames` still lists every file present on the remote.
   */
  onlyFiles?: string[];
  /**
   * Called after each file is successfully downloaded into `files`.
   * `total` is the number of names scheduled for this snapshot (after `onlyFiles`).
   * Skipped names (missing blob sha) and failed fetches do not fire this callback.
   */
  onFileProgress?: (completed: number, total: number) => void;
}

export interface RemoteWriteResult {
  id: string;
  htmlUrl: string;
  created: boolean;
}

export interface RemoteWriteOptions {
  deleteNames?: string[];
  /** Repo Git Data blob uploads only; Gist ignores this. */
  onBlobProgress?: (completed: number, total: number) => void;
  /** Repo Git Data tree-create chunks only; Gist ignores this. */
  onTreeProgress?: (completed: number, total: number) => void;
}

export interface RemoteDiscoverResult {
  id: string;
  htmlUrl: string;
}

export function remoteSnapshotFileNames(snapshot: RemoteSnapshot): string[] {
  return snapshot.allFileNames ?? Object.keys(snapshot.files);
}

export interface RemoteSyncBackend {
  readonly type: SyncDestinationType;
  remoteLabel(): string;
  remoteUrl(): string | undefined;
  discover(): Promise<ApiResult<RemoteDiscoverResult | null>>;
  getSnapshot(
    options?: RemoteSnapshotOptions
  ): Promise<ApiResult<RemoteSnapshot>>;
  /**
   * Atomically upsert files and optionally delete others.
   * File names are gist-flat (e.g. manifest.json, cursor-user--settings.json).
   * RepoBackend maps `--` names to nested Git paths under `basePath`.
   */
  writeFiles(
    files: Record<string, string>,
    options?: RemoteWriteOptions
  ): Promise<ApiResult<RemoteWriteResult>>;
}

export type { SyncDestination, SyncDestinationType, SyncState };
