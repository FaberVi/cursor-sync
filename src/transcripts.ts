export type { ProjectInfo, TranscriptFileEntry, ExportConversationCandidate } from "./transcripts-discovery.js";
export {
  resolveProjectsRoot,
  discoverProjects,
  findProjectMatchingOpenWorkspaceFolder,
  enumerateTranscriptFiles,
  enumerateTranscriptFilesInConversation,
  discoverExportConversationCandidates,
} from "./transcripts-discovery.js";
export { executeExportTranscripts } from "./transcripts-export.js";
export { executeImportTranscripts } from "./transcripts-import-execute.js";

import {
  extractComposerDataPayload,
  extractComposerHeadersPayload,
  mergeComposerDataAdditive,
  mergeComposerHeadersChain,
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  escapeSqlLiteral,
} from "./composer-merge.js";
import {
  isCommandMissingError,
  querySqliteRowsImpl,
  querySqliteRows,
  runSqliteQuery,
  runSqliteScript,
  resolveStateDbCandidates,
  listGlobalStateVscdbPaths,
  isExecFileTimeoutError,
} from "./transcripts-sqlite.js";
import { resolveChatsRoot, findStoreDbForConversation } from "./transcripts-cursor-paths.js";
import { stampWorkspaceIdentifierOnPayload } from "./transcripts-import-sidebar.js";

export const __transcriptsTestUtils = {
  extractComposerHeadersPayload,
  extractComposerDataPayload,
  mergeComposerHeadersChain,
  mergeComposerDataAdditive,
  isCommandMissingError,
  isExecFileTimeoutError,
  querySqliteRowsImpl,
};

export const __chatPersistenceInternals = {
  runSqliteQuery,
  runSqliteScript,
  querySqliteRows,
  resolveStateDbCandidates,
  listGlobalStateVscdbPaths,
  resolveChatsRoot,
  findStoreDbForConversation,
  escapeSqlLiteral,
  mergeComposerHeadersChain,
  mergeComposerDataAdditive,
  extractComposerHeadersPayload,
  extractComposerDataPayload,
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  stampWorkspaceIdentifierOnPayload,
  isExecFileTimeoutError,
};
