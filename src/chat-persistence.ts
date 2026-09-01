import type { TranscriptBundleArtifactEncoding } from "./transcript-bundle.js";
import type { VerifyCheck } from "./chat-import-verify.js";
import * as vscode from "vscode";

export {
  ensurePythonReady,
  restoreChatBundle,
  __chatPersistenceTestUtils,
} from "./chat-persistence-restore.js";
export {
  restoreNativeChatJson,
  restoreNativeChatsBatch,
} from "./chat-native-import.js";
export { buildChatBundle, buildChatExportPayload } from "./chat-bundle-build.js";
export {
  executeSaveChatLocal,
  executeLoadChatLocal,
  executeImportChatBundle,
  executeImportChatBundleActivate,
  chatEditorExportFailureMessage,
  executeExportChatBundle,
  executeExportCurrentChatBundle,
  executeVerifyChatImport,
} from "./chat-persistence-commands.js";

/** Layer 4 cursorDiskKV rows (global state.vscdb); matches Python export_disk_kv_snapshot. */
export interface ChatBundleDiskKvSnapshotRow {
  key: string;
  value: string;
  checksum: string;
}

export interface ChatBundleDiskKvSnapshot {
  sourceStateDbPath: string;
  rows: ChatBundleDiskKvSnapshotRow[];
  rowCount: number;
  toolBubbleCount: number;
}

/** Schema for locally-persisted chat bundle (v1 or v2). */
export interface ChatBundle {
  schemaVersion: 1 | 2;
  type: "chat-persistence";
  createdAt: string;
  conversationId: string;
  title: string;
  subtitle: string;
  previewText: string;
  sidebarSnapshot: Record<string, unknown> | null;
  storeSnapshot: {
    content: string;
    encoding: TranscriptBundleArtifactEncoding;
    checksum: string;
    sizeBytes: number;
    sourceWorkspaceKey: string;
  } | null;
  transcriptFiles: Array<{
    relativePath: string;
    content: string;
    encoding?: TranscriptBundleArtifactEncoding;
    checksum: string;
    sizeBytes: number;
  }>;
  diskKvSnapshot?: ChatBundleDiskKvSnapshot | null;
}

export interface LoadChatResult {
  conversationId: string;
  transcriptsWritten: number;
  storeWritten: boolean;
  storeWorkspaceKey?: string;
  sidebarMerged: boolean;
  warnings: string[];
  verifyChecks?: VerifyCheck[];
  fidelity?: import("./chat-bundle-fidelity.js").ChatBundleFidelitySummary;
}

export interface RestoreChatBundleOptions {
  activate?: boolean;
  activateStrict?: boolean;
  bridgeWaitResultMs?: number;
  pingServer?: boolean;
  dryRun?: boolean;
  syncGlobal?: boolean;
  pinRecent?: boolean;
  workspaceFolder?: string;
  postActivate?: boolean;
}

export function restoreOptionsFromConfiguration(): RestoreChatBundleOptions {
  const config = vscode.workspace.getConfiguration("cursorSync");
  const bridgeWaitSeconds =
    config.get<number>("chatImport.bridgeWaitResultSeconds") ?? 0;
  return {
    activate: config.get<boolean>("chatImport.activateDefault") ?? false,
    activateStrict: config.get<boolean>("chatImport.activateStrict") ?? false,
    bridgeWaitResultMs: Math.max(0, bridgeWaitSeconds) * 1000,
    pingServer: config.get<boolean>("chatImport.pingServer") ?? false,
  };
}
