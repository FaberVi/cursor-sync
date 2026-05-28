import type { TranscriptBundleArtifactKind } from "./transcript-bundle.js";

export type DelayedWritebackHandle = {
  timer: NodeJS.Timeout;
  cancel: () => void;
  complete: () => Promise<void>;
};

export interface ExportConversationState {
  projectKey: string;
  conversationId: string;
  transcriptArtifacts: string[];
  transcriptRelativePaths: string[];
  primaryTranscriptContent: string;
  primaryTranscriptSelectedAt: string;
  lastUpdatedAt: string;
  warnings: string[];
  storeArtifact?: string;
  sourceWorkspaceKey?: string;
}

export interface ComposerHeadersPayload {
  allComposers: Array<Record<string, unknown>>;
}

export interface ExportProjectAccumulator {
  folderName: string;
  fileCount: number;
  conversationIds: Set<string>;
  artifactCount: number;
}

export interface SidebarStateEvidence {
  stateDbPath: string;
  extraction: "state-db-match" | "state-db-unmatched";
  matchedItemTableRows: Array<{ key: string; value: unknown }>;
  matchedCursorDiskRows: Array<{ key: string; value: unknown }>;
  composerSummaryRows: Array<{ key: string; valueLength: number }>;
}

export interface RestoreOperation {
  absolutePath: string;
  content: Buffer;
  checksum: string;
  syncKey: string;
  kind: TranscriptBundleArtifactKind;
  conversationId?: string;
}

export interface RestorePreview {
  newFiles: RestoreOperation[];
  conflicts: RestoreOperation[];
  unchanged: RestoreOperation[];
}

export interface ImportRestoreReport {
  transcriptWritten: number;
  storeWritten: number;
  sidebarWritten: number;
  stateDbMerged: number;
  stateDbSkippedNoPayload: number;
  stateDbSkippedNoDb: number;
  statePartial: boolean;
  warnings: string[];
}

export interface StateRestoreOutcome {
  stateDbMerged: number;
  stateDbSkippedNoPayload: number;
  stateDbSkippedNoDb: number;
  statePartial: boolean;
  warnings: string[];
  delayedWriteback?: DelayedWritebackHandle;
}
