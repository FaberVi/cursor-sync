export interface SyncFileEntry {
  absolutePath: string;
  relativeSyncKey: string;
}

export interface ManifestFileEntry {
  checksum: string;
  sizeBytes: number;
  encoding?: "base64";
}

export interface Manifest {
  schemaVersion: 1;
  syncProfileName: string;
  createdAt: string;
  sourceMachineId: string;
  sourceOS: "win32" | "darwin" | "linux";
  files: Record<string, ManifestFileEntry>;
}

export type SyncDestinationType = "gist" | "repo";

export interface SyncDestination {
  type: SyncDestinationType;
  gistId?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  basePath?: string;
}

export interface SyncState {
  lastSyncTimestamp: string;
  lastSyncDirection: "push" | "pull";
  /** @deprecated Prefer destination; kept for backward compatibility with gist sync. */
  gistId: string;
  destination?: SyncDestination;
  localChecksums: Record<string, string>;
  remoteChecksums: Record<string, string>;
}

export interface PackagedFile {
  content: string;
  checksum: string;
  sizeBytes: number;
  encoding?: "base64";
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface ApiError {
  category: FailureCategory;
  message: string;
  statusCode?: number;
  retryAfter?: number;
}

export type FailureCategory =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "CONFLICT"
  | "FILE_SYSTEM_ERROR"
  | "UNKNOWN";

export interface GistFile {
  content: string;
  filename?: string;
  truncated?: boolean;
  raw_url?: string;
}

export interface GistResponse {
  id: string;
  html_url: string;
  description: string;
  files: Record<string, GistFile>;
  created_at: string;
  updated_at: string;
}

export interface ConflictEntry {
  relativeSyncKey: string;
  localChecksum: string;
  remoteChecksum: string;
  baseChecksum: string;
}

export type ConflictResolution = "keepLocal" | "keepRemote" | "skip";

export interface ResolvedConflict {
  relativeSyncKey: string;
  resolution: ConflictResolution;
}

export interface SyncHistoryEntry {
  timestamp: string;
  direction: "push" | "pull";
  trigger: "manual" | "scheduled" | "syncNow";
  /** Files uploaded (push) or written (pull) in this operation. */
  fileCount: number;
  /**
   * Total tracked sync files in the remote/manifest after (or for) this op.
   * Absent on older history entries.
   */
  totalFileCount?: number;
  success: boolean;
  error?: string;
  /** Sync keys involved in this operation (absent on older history entries). */
  files?: string[];
}
