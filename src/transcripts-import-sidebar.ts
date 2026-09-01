import * as path from "node:path";
import { getComposerId } from "./composer-merge.js";
import type { TranscriptBundleArtifactEntry } from "./transcript-bundle.js";
import { summarizeTranscriptForSidebar } from "./transcript-bundle.js";
import {
  resolveStateDbCandidates,
  querySqliteRows,
  isExecFileTimeoutError,
  coerceSqliteValue,
  parseFullJsonValue,
  parseFullComposerHeadersValue,
  filterComposerHeadersByIds,
} from "./transcripts-sqlite.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import type {
  ExportConversationState,
  ComposerHeadersPayload,
  ImportRestoreReport,
  StateRestoreOutcome,
  SidebarStateEvidence,
} from "./transcripts-internal-types.js";
import type { ProjectInfo } from "./transcripts-discovery.js";

export {
  applySidebarStateRestoration,
  stampWorkspaceIdentifierOnPayload,
} from "./transcripts-import-sidebar-apply.js";

export function mergeStateOutcomeIntoReport(
  base: ImportRestoreReport,
  state: StateRestoreOutcome
): ImportRestoreReport {
  return {
    ...base,
    stateDbMerged: state.stateDbMerged,
    stateDbSkippedNoPayload: state.stateDbSkippedNoPayload,
    stateDbSkippedNoDb: state.stateDbSkippedNoDb,
    statePartial: base.statePartial || state.statePartial,
    warnings: [...base.warnings, ...state.warnings],
  };
}

function collectComposerIdsForConversation(conversationState: ExportConversationState): Set<string> {
  const ids = new Set<string>([conversationState.conversationId]);
  for (const relativePath of conversationState.transcriptRelativePaths) {
    const baseName = path.basename(relativePath, path.extname(relativePath));
    if (baseName) {
      ids.add(baseName);
    }
  }
  return ids;
}

function filterComposerDataPayload(value: unknown, composerIds: ReadonlySet<string>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "allComposers" && Array.isArray(entry)) {
      filtered[key] = entry.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return false;
        }
        const id = getComposerId(item as Record<string, unknown>);
        return id.length > 0 && composerIds.has(id);
      });
      continue;
    }
    if (composerIds.has(key)) {
      filtered[key] = entry;
    } else if (!isLikelyComposerIdKey(key)) {
      filtered[key] = entry;
    }
  }
  return filtered;
}

function isLikelyComposerIdKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function buildFallbackComposerHeadersPayload(
  conversationId: string,
  summary: ReturnType<typeof summarizeTranscriptForSidebar>,
  exportedAt: string
): ComposerHeadersPayload {
  const timestamp = summary.lastUpdatedAt ?? exportedAt;
  return {
    allComposers: [
      {
        type: "head",
        composerId: conversationId,
        name: summary.title,
        subtitle: summary.subtitle,
        lastUpdatedAt: timestamp,
        lastOpenedAt: timestamp,
        createdAt: timestamp,
        hasUnreadMessages: false,
        isArchived: false,
        isDraft: false,
      },
    ],
  };
}

async function extractSidebarStateEvidence(
  conversationId: string
): Promise<SidebarStateEvidence | undefined> {
  const stateDbCandidates = await resolveStateDbCandidates();
  const escapedConversationId = conversationId.replace(/'/g, "''");

  for (const stateDbPath of stateDbCandidates) {
    let matchedItemTableRows: Array<Record<string, unknown>>;
    let matchedCursorDiskRows: Array<Record<string, unknown>>;
    let composerSummaryRows: Array<Record<string, unknown>>;
    try {
      matchedItemTableRows = await querySqliteRows(
        stateDbPath,
        `SELECT key, value FROM ItemTable WHERE value LIKE '%${escapedConversationId}%' LIMIT 10;`
      );
      matchedCursorDiskRows = await querySqliteRows(
        stateDbPath,
        `SELECT key, value FROM cursorDiskKV WHERE key LIKE '%${escapedConversationId}%' OR value LIKE '%${escapedConversationId}%' LIMIT 10;`
      );
      composerSummaryRows = await querySqliteRows(
        stateDbPath,
        "SELECT key, length(value) AS valueLength FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData') LIMIT 5;"
      );
    } catch (error) {
      if (isExecFileTimeoutError(error)) {
        continue;
      }
      throw error;
    }

    if (
      matchedItemTableRows.length > 0 ||
      matchedCursorDiskRows.length > 0 ||
      composerSummaryRows.length > 0
    ) {
      return {
        stateDbPath,
        extraction:
          matchedItemTableRows.length > 0 || matchedCursorDiskRows.length > 0
            ? "state-db-match"
            : "state-db-unmatched",
        matchedItemTableRows: matchedItemTableRows.map((row) => ({
          key: String(row.key ?? ""),
          value: coerceSqliteValue(row.value),
        })),
        matchedCursorDiskRows: matchedCursorDiskRows.map((row) => ({
          key: String(row.key ?? ""),
          value: coerceSqliteValue(row.value),
        })),
        composerSummaryRows: composerSummaryRows.map((row) => ({
          key: String(row.key ?? ""),
          valueLength: Number(row.valueLength ?? 0),
        })),
      };
    }
  }

  return undefined;
}

export async function buildSidebarMetadataSnapshot(
  conversationState: ExportConversationState,
  exportedAt: string
): Promise<Record<string, unknown>> {
  const summary = summarizeTranscriptForSidebar(
    conversationState.primaryTranscriptContent,
    conversationState.conversationId
  );
  const evidence = await extractSidebarStateEvidence(conversationState.conversationId);

  const composerIds = collectComposerIdsForConversation(conversationState);
  let composerHeadersRestore: unknown;
  let composerDataRestore: unknown;
  if (evidence?.stateDbPath) {
    try {
      const headerRows = await querySqliteRows(
        evidence.stateDbPath,
        "SELECT key, value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1;"
      );
      const headerRaw = headerRows[0]?.value;
      if (headerRaw != null) {
        const fullHeadersParsed = parseFullComposerHeadersValue(headerRaw);
        if (fullHeadersParsed) {
          const filtered = filterComposerHeadersByIds(fullHeadersParsed, composerIds);
          if (filtered.allComposers.length > 0) {
            composerHeadersRestore = filtered;
          }
        }
      }
      const dataRows = await querySqliteRows(
        evidence.stateDbPath,
        "SELECT key, value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1;"
      );
      const dataRaw = dataRows[0]?.value;
      if (dataRaw != null) {
        const parsedComposerData = parseFullJsonValue(dataRaw);
        if (parsedComposerData && typeof parsedComposerData === "object" && !Array.isArray(parsedComposerData)) {
          composerDataRestore = filterComposerDataPayload(parsedComposerData, composerIds);
        }
      }
    } catch (error) {
      if (!isExecFileTimeoutError(error)) {
        throw error;
      }
    }
  }
  const fallbackComposerHeaders = buildFallbackComposerHeadersPayload(
    conversationState.conversationId,
    summary,
    exportedAt
  );
  const composerHeadersPayload =
    composerHeadersRestore && typeof composerHeadersRestore === "object"
      ? (composerHeadersRestore as Record<string, unknown>)
      : fallbackComposerHeaders;

  return {
    schemaVersion: 1,
    snapshotType: "cursor-sidebar-metadata",
    exportedAt,
    projectKey: conversationState.projectKey,
    conversationId: conversationState.conversationId,
    title: summary.title,
    subtitle: summary.subtitle,
    previewText: summary.previewText,
    messageCount: summary.messageCount,
    participants: summary.participants,
    lastUpdatedAt: summary.lastUpdatedAt ?? conversationState.lastUpdatedAt ?? exportedAt,
    transcriptRelativePaths: [...conversationState.transcriptRelativePaths].sort(),
    storeSnapshotIncluded: Boolean(conversationState.storeArtifact),
    sourceWorkspaceKey: conversationState.sourceWorkspaceKey ?? null,
    extraction: evidence?.extraction ?? "derived-only",
    stateDbPath: evidence?.stateDbPath ?? null,
    matchedItemTableRows: evidence?.matchedItemTableRows ?? [],
    matchedCursorDiskRows: evidence?.matchedCursorDiskRows ?? [],
    composerSummaryRows: evidence?.composerSummaryRows ?? [],
    composerHeaders: composerHeadersPayload,
    composerHeadersRestore: composerHeadersRestore ?? null,
    composerData: composerDataRestore ?? null,
    composerDataRestore: composerDataRestore ?? null,
    warnings: [...conversationState.warnings].sort(),
  };
}

export function resolveArtifactImportPath(
  targetProject: ProjectInfo,
  artifactEntry: TranscriptBundleArtifactEntry,
  workspaceMapping: ReadonlyMap<string, string>
): string {
  if (artifactEntry.kind === "transcript") {
    const relativePath =
      artifactEntry.sourceRelativePath ??
      `${artifactEntry.conversationId}/${path.basename(artifactEntry.conversationId)}.jsonl`;
    return path.join(targetProject.fullPath, "agent-transcripts", ...relativePath.split("/"));
  }

  if (artifactEntry.kind === "store") {
    const swk = artifactEntry.sourceWorkspaceKey;
    const mapped =
      typeof swk === "string" && swk.length > 0 ? workspaceMapping.get(swk) ?? "" : "";
    return path.join(resolveChatsRoot(), mapped, artifactEntry.conversationId, "store.db");
  }

  return path.join(
    targetProject.fullPath,
    "agent-transcripts",
    artifactEntry.conversationId,
    "cursor-sidebar-metadata.json"
  );
}
