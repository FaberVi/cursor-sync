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
}

export interface RemoteWriteResult {
  id: string;
  htmlUrl: string;
  created: boolean;
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
   * File names are flat (e.g. manifest.json, cursor-user--settings.json).
   */
  writeFiles(
    files: Record<string, string>,
    options?: { deleteNames?: string[] }
  ): Promise<ApiResult<RemoteWriteResult>>;
}

export type { SyncDestination, SyncDestinationType, SyncState };
