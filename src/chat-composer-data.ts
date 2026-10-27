import { randomBytes } from "node:crypto";
import {
  escapeSqlLiteral,
  mergeComposerDataAdditive,
} from "./composer-merge.js";
import { cursorDiskKvValueAsText } from "./chat-disk-kv-export.js";
import { partialStateHasConversationContent } from "./chat-partial-state.js";
import { querySqliteRows, runSqliteScript } from "./transcripts-sqlite.js";
import type { ChatBundle } from "./chat-persistence.js";
import {
  rebindComposerRecord,
  type WorkspaceIdentifier,
} from "./chat-composer-headers.js";

const UUID_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function filterComposerDataForConversation(
  data: Record<string, unknown>,
  conversationId: string
): Record<string, unknown> {
  if (!data || Object.keys(data).length === 0) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "allComposers" && Array.isArray(value)) {
      out[key] = value.filter(
        (e): e is Record<string, unknown> =>
          !!e && typeof e === "object" && !Array.isArray(e) && e.composerId === conversationId
      );
    } else if (key === conversationId) {
      out[key] = value;
    } else if (!UUID_KEY_RE.test(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function composerDataForFocus(
  conversationId: string,
  existingRaw: string | undefined
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (existingRaw && existingRaw.trim().length > 0) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {}
  }
  const merged = { ...base };
  merged.selectedComposerIds = [conversationId];
  merged.lastFocusedComposerIds = [conversationId];
  if (!("hasMigratedComposerData" in merged)) {
    merged.hasMigratedComposerData = true;
  }
  if (!("hasMigratedMultipleComposers" in merged)) {
    merged.hasMigratedMultipleComposers = true;
  }
  return merged;
}

function randomB64Key(numBytes = 32): string {
  return randomBytes(numBytes).toString("base64");
}

export function composerDataEntryIsRich(entry: Record<string, unknown>): boolean {
  const headers = entry.fullConversationHeadersOnly;
  if (Array.isArray(headers) && headers.length > 0) {
    return true;
  }
  const map = entry.conversationMap;
  return !!map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0;
}

export function composerDataEntryHasConversationSignals(
  entry: Record<string, unknown>
): boolean {
  if (composerDataEntryIsRich(entry)) {
    return true;
  }
  const cs = entry.conversationState;
  return typeof cs === "string" && cs.startsWith("~") && cs.length > 1;
}

function parseComposerDataEntryValue(raw: unknown): Record<string, unknown> | null {
  const asStr =
    cursorDiskKvValueAsText(raw) ??
    (raw != null && typeof raw !== "string" ? JSON.stringify(raw) : undefined);
  if (!asStr?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(asStr) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/** Decode hex or UTF-8 cursorDiskKV composerData value JSON. */
export function parseComposerDataKvJson(raw: unknown): Record<string, unknown> | null {
  return parseComposerDataEntryValue(raw);
}

async function readComposerDataEntryFromDiskKv(
  dbPath: string,
  conversationId: string
): Promise<Record<string, unknown> | null> {
  const keyLit = escapeSqlLiteral(`composerData:${conversationId}`);
  const rows = await querySqliteRows(
    dbPath,
    `SELECT value FROM cursorDiskKV WHERE key = '${keyLit}' LIMIT 1;`,
    { retries: 2 }
  );
  return parseComposerDataEntryValue(rows[0]?.value);
}

export async function readRichComposerDataEntryFromStateDb(
  dbPath: string,
  conversationId: string
): Promise<Record<string, unknown> | null> {
  const fromDiskKv = await readComposerDataEntryFromDiskKv(dbPath, conversationId);
  if (fromDiskKv && composerDataEntryHasConversationSignals(fromDiskKv)) {
    return fromDiskKv;
  }

  const rows = await querySqliteRows(
    dbPath,
    "SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1;",
    { retries: 2 }
  );
  const parsed = parseComposerDataEntryValue(rows[0]?.value);
  if (!parsed) {
    return fromDiskKv;
  }
  const filtered = filterComposerDataForConversation(parsed, conversationId);
  const entry = filtered[conversationId];
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const rec = entry as Record<string, unknown>;
    if (composerDataEntryHasConversationSignals(rec)) {
      return rec;
    }
  }
  return fromDiskKv;
}

export function buildMinimalComposerDataForOpen(
  conversationId: string,
  title: string,
  workspaceIdentifier: WorkspaceIdentifier,
  createdAtMs: number = Date.now()
): Record<string, unknown> {
  return {
    _v: 16,
    composerId: conversationId,
    name: title,
    richText: "",
    text: "",
    hasLoaded: true,
    fullConversationHeadersOnly: [],
    conversationMap: {},
    status: "completed",
    context: {
      composers: [],
      mentions: {
        composers: {},
        selectedCommits: {},
        selectedPullRequests: {},
        gitDiff: [],
        gitDiffFromBranchToMain: [],
        selectedImages: {},
        folderSelections: {},
        fileSelections: {},
        terminalFiles: {},
        selections: {},
        terminalSelections: {},
        selectedDocs: {},
        externalLinks: {},
        diffHistory: [],
        cursorRules: {},
        cursorCommands: {},
        uiElementSelections: [],
        consoleLogs: [],
        ideEditorsState: [],
        gitPRDiffSelections: {},
        subagentSelections: {},
        browserSelections: {},
      },
    },
    generatingBubbleIds: [],
    isReadingLongFile: false,
    codeBlockData: {},
    originalFileStates: {},
    newlyCreatedFiles: [],
    newlyCreatedFolders: [],
    createdAt: createdAtMs,
    unifiedMode: "agent",
    forceMode: "agent",
    modelConfig: { modelName: "default", maxMode: false },
    isDraft: false,
    conversationState: "~",
    queueItems: [],
    isAgentic: true,
    workspaceIdentifier,
    speculativeSummarizationEncryptionKey: randomB64Key(),
    blobEncryptionKey: randomB64Key(),
    isNAL: true,
  };
}

export function prepareComposerDataForImport(
  existingDataRaw: string | undefined,
  bundle: ChatBundle,
  conversationId: string,
  workspaceIdentifier: WorkspaceIdentifier
): Record<string, unknown> {
  let merged = composerDataForFocus(conversationId, existingDataRaw);
  const snap = bundle.sidebarSnapshot;
  if (snap && typeof snap === "object" && !Array.isArray(snap)) {
    const rawData = snap.composerData;
    if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
      const extra = filterComposerDataForConversation(rawData as Record<string, unknown>, conversationId);
      if (Object.keys(extra).length > 0) {
        merged = mergeComposerDataAdditive(JSON.stringify(merged), [extra]);
      }
    }
  }
  const blob = merged[conversationId];
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
    merged[conversationId] = buildMinimalComposerDataForOpen(
      conversationId,
      bundle.title ?? conversationId,
      workspaceIdentifier
    );
  } else {
    merged[conversationId] = rebindComposerRecord(
      blob as Record<string, unknown>,
      workspaceIdentifier
    );
  }
  return merged;
}

/**
 * @deprecated No longer called from restoreChatBundle; Python handles sidebar writes. Retained for tests only.
 */
export async function repairComposerDataAfterActivation(
  dbPath: string,
  conversationId: string,
  partial: Record<string, unknown>
): Promise<void> {
  if (!partialStateHasConversationContent(partial)) {
    return;
  }
  const rows = await querySqliteRows(
    dbPath,
    "SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1;",
    { retries: 2 }
  );
  const rowValue = rows[0]?.value;
  let existingRaw: string | undefined;
  if (rowValue !== undefined && rowValue !== null) {
    existingRaw = typeof rowValue === "string" ? rowValue : JSON.stringify(rowValue);
  }
  let merged: Record<string, unknown>;
  try {
    const parsed = existingRaw ? JSON.parse(existingRaw) : {};
    merged =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    merged = {};
  }
  merged[conversationId] = partial;
  const mergedStr = JSON.stringify(merged);
  const valLit = escapeSqlLiteral(mergedStr);
  const script = [
    "BEGIN IMMEDIATE;",
    `INSERT INTO ItemTable (key, value) VALUES ('composer.composerData', '${valLit}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    "COMMIT;"
  ].join("\n");
  await runSqliteScript(dbPath, script);
}
