import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatBundle } from "./chat-persistence.js";
import {
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  escapeSqlLiteral,
  getComposerId,
  mergeComposerDataAdditive,
  mergeComposerHeadersChain,
} from "./composer-merge.js";
import { cursorDiskKvValueAsText } from "./chat-disk-kv-export.js";
import {
  clearSessionBindingInTree,
  partialStateHasConversationContent,
} from "./chat-partial-state.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { querySqliteRows, runSqliteScript, listGlobalStateVscdbPaths, resolveStateDbCandidates } =
  __chatPersistenceInternals;

const UUID_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorkspaceIdentifier {
  id: string;
  uri: Record<string, unknown>;
}

export interface MergeTargetsOptions {
  stateDbPath?: string | null;
  syncGlobal: boolean;
}

export interface SidebarMergeResult {
  merged: boolean;
  warnings: string[];
}

export interface PrepareHeadersOptions {
  pinRecent?: boolean;
}

function composerTimestampMs(record: Record<string, unknown>): number {
  let best = 0;
  for (const field of ["lastUpdatedAt", "lastOpenedAt", "createdAt"] as const) {
    const raw = record[field];
    if (typeof raw === "number" && raw > 0) {
      const v = Math.trunc(raw);
      best = Math.max(best, v >= 1_000_000_000_000 ? v : v * 1000);
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      if (/^\d+$/.test(raw.trim())) {
        const v = parseInt(raw.trim(), 10);
        best = Math.max(best, v >= 1_000_000_000_000 ? v : v * 1000);
      } else {
        const parsed = Date.parse(raw.replace("Z", "+00:00"));
        if (!Number.isNaN(parsed)) {
          best = Math.max(best, parsed);
        }
      }
    }
  }
  return best;
}

function maxComposerTimestampMs(headers: Record<string, unknown>): number {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return 0;
  }
  let max = 0;
  for (const entry of composers) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      max = Math.max(max, composerTimestampMs(entry as Record<string, unknown>));
    }
  }
  return max;
}

export function filterComposerHeadersForConversation(
  headers: Record<string, unknown>,
  conversationId: string
): { allComposers: Array<Record<string, unknown>> } {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return { allComposers: [] };
  }
  const kept = composers.filter(
    (c): c is Record<string, unknown> =>
      !!c && typeof c === "object" && !Array.isArray(c) && c.composerId === conversationId
  );
  return { allComposers: kept };
}

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

function deriveHeadersFromBundle(bundle: ChatBundle): { allComposers: Array<Record<string, unknown>> } {
  const derived = deriveComposerHeadersPayloadFromSidebarSnapshot({
    conversationId: bundle.conversationId,
    title: bundle.title,
    subtitle: bundle.subtitle,
    lastUpdatedAt: bundle.createdAt,
  });
  if (derived && Array.isArray(derived.allComposers)) {
    return { allComposers: derived.allComposers as Array<Record<string, unknown>> };
  }
  return { allComposers: [] };
}

export function headersPayloadForImport(bundle: ChatBundle): { allComposers: Array<Record<string, unknown>> } {
  const cid = bundle.conversationId?.trim();
  if (!cid) {
    return deriveHeadersFromBundle(bundle);
  }

  const payloads: Array<Record<string, unknown>> = [];
  let snapshotHasName = false;
  const snap = bundle.sidebarSnapshot;
  if (snap && typeof snap === "object" && !Array.isArray(snap)) {
    const rawHeaders = snap.composerHeaders;
    if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      const filtered = filterComposerHeadersForConversation(rawHeaders as Record<string, unknown>, cid);
      if (filtered.allComposers.length > 0) {
        payloads.push(filtered);
        const row = filtered.allComposers[0]!;
        const name = row.name;
        snapshotHasName = typeof name === "string" && name.trim().length > 0;
      }
    }
  }
  const derived = deriveHeadersFromBundle(bundle);
  if (snapshotHasName) {
    payloads.push({
      allComposers: derived.allComposers.map((row) => {
        if (row.composerId !== cid) {
          return row;
        }
        const { name: _name, ...rest } = row;
        return rest;
      }),
    });
  } else {
    payloads.push(derived);
  }
  return mergeComposerHeadersChain(undefined, payloads);
}

export function pinComposerAsMostRecent(
  headers: { allComposers: Array<Record<string, unknown>> },
  conversationId: string
): { allComposers: Array<Record<string, unknown>> } {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return headers;
  }
  const nowMs = Date.now();
  const pinMs = Math.max(maxComposerTimestampMs(headers as Record<string, unknown>), nowMs) + 1;
  const updated: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of composers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      updated.push(entry);
      continue;
    }
    if (entry.composerId !== conversationId) {
      updated.push(entry);
      continue;
    }
    found = true;
    const bumped = { ...entry };
    bumped.lastUpdatedAt = pinMs;
    bumped.lastOpenedAt = pinMs;
    if (!bumped.type) {
      bumped.type = "head";
    }
    bumped.hasUnreadMessages = false;
    bumped.isArchived = false;
    bumped.isDraft = false;
    updated.push(bumped);
  }
  if (!found) {
    const derived = deriveHeadersFromBundle({
      conversationId,
      title: conversationId,
      subtitle: "",
      createdAt: new Date(pinMs).toISOString(),
    } as ChatBundle);
    if (derived.allComposers.length > 0) {
      const row = { ...derived.allComposers[0]! };
      row.lastUpdatedAt = pinMs;
      row.lastOpenedAt = pinMs;
      updated.push(row);
    }
  }
  return { allComposers: updated };
}

export function rebindComposerRecord(
  record: Record<string, unknown>,
  workspaceIdentifier: WorkspaceIdentifier,
  nowMs: number = Date.now()
): Record<string, unknown> {
  const cleared = clearSessionBindingInTree(record);
  const row =
    cleared && typeof cleared === "object" && !Array.isArray(cleared)
      ? (cleared as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {
    ...row,
    workspaceIdentifier,
    createdAt: nowMs,
    lastUpdatedAt: nowMs,
    lastOpenedAt: nowMs,
  };
  if ("conversationCheckpointLastUpdatedAt" in out) {
    out.conversationCheckpointLastUpdatedAt = nowMs;
  }
  const headers = out.fullConversationHeadersOnly;
  if (Array.isArray(headers)) {
    out.fullConversationHeadersOnly = headers.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      return {
        ...entry,
        workspaceIdentifier,
        createdAt: nowMs,
        lastUpdatedAt: nowMs,
        lastOpenedAt: nowMs,
        conversationCheckpointLastUpdatedAt: nowMs,
      };
    });
  }
  return out;
}

export function stampWorkspaceIdentifierOnHeaders(
  headers: { allComposers: Array<Record<string, unknown>> },
  conversationId: string,
  workspaceIdentifier: WorkspaceIdentifier
): { allComposers: Array<Record<string, unknown>> } {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return headers;
  }
  const updated = composers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    if (entry.composerId !== conversationId) {
      return entry;
    }
    const ts = typeof entry.lastUpdatedAt === "number" ? entry.lastUpdatedAt : Date.now();
    return rebindComposerRecord(entry, workspaceIdentifier, ts);
  });
  return { allComposers: updated };
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

export function prepareHeadersForImport(
  existingHeadersRaw: string | undefined,
  bundle: ChatBundle,
  conversationId: string,
  workspaceIdentifier: WorkspaceIdentifier,
  options: PrepareHeadersOptions = {}
): { allComposers: Array<Record<string, unknown>> } {
  const pinRecent = options.pinRecent !== false;
  const headersPayload = headersPayloadForImport(bundle);
  let merged = mergeComposerHeadersChain(existingHeadersRaw, [headersPayload]);
  if (pinRecent) {
    merged = pinComposerAsMostRecent(merged, conversationId);
  }
  return stampWorkspaceIdentifierOnHeaders(merged, conversationId, workspaceIdentifier);
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @deprecated No longer called from restoreChatBundle; Python handles sidebar writes. Retained for tests only.
 */
export async function mergeTargetsForImport(
  stateDbPath: string | null | undefined,
  syncGlobal: boolean
): Promise<string[]> {
  const targets: string[] = [];
  const seen = new Set<string>();

  if (stateDbPath) {
    const resolved = path.resolve(stateDbPath);
    if (await fileExists(resolved)) {
      targets.push(resolved);
      seen.add(resolved);
    }
  }

  if (syncGlobal) {
    const globalDbs = await listGlobalStateVscdbPaths();
    for (const g of globalDbs) {
      const gp = path.resolve(g);
      if (!seen.has(gp)) {
        targets.push(gp);
        seen.add(gp);
        break;
      }
    }
  }

  if (targets.length === 0) {
    const candidates = await resolveStateDbCandidates();
    for (const c of candidates) {
      const cp = path.resolve(c);
      if (!seen.has(cp)) {
        targets.push(cp);
        seen.add(cp);
        break;
      }
    }
  }

  return targets;
}

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

export async function mergeSidebarIntoStateDb(
  dbPath: string,
  bundle: ChatBundle,
  workspaceIdentifier: WorkspaceIdentifier,
  options: { dryRun?: boolean; pinRecent?: boolean } = {}
): Promise<SidebarMergeResult> {
  const warnings: string[] = [];
  const dryRun = options.dryRun === true;
  const pinRecent = options.pinRecent !== false;

  const snap = bundle.sidebarSnapshot;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    warnings.push("No sidebarSnapshot in bundle; state merge skipped.");
    return { merged: false, warnings };
  }

  const cid = bundle.conversationId?.trim();
  if (!cid) {
    warnings.push("Bundle missing conversationId; state merge skipped.");
    return { merged: false, warnings };
  }

  const rows = await querySqliteRows(
    dbPath,
    "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');",
    { retries: 3 }
  );

  let existingHeadersRaw: string | undefined;
  let existingDataRaw: string | undefined;
  for (const row of rows) {
    const key = String(row.key ?? "");
    const value = row.value;
    if (key === "composer.composerHeaders") {
      existingHeadersRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
    if (key === "composer.composerData") {
      existingDataRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  const mergedHeaders = prepareHeadersForImport(
    existingHeadersRaw,
    bundle,
    cid,
    workspaceIdentifier,
    { pinRecent }
  );

  const mergedData = prepareComposerDataForImport(
    existingDataRaw,
    bundle,
    cid,
    workspaceIdentifier
  );
  const scriptParts: string[] = ["BEGIN IMMEDIATE;"];

  if (mergedHeaders.allComposers.length > 0) {
    const escaped = escapeSqlLiteral(JSON.stringify(mergedHeaders));
    scriptParts.push(
      `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerHeaders';`,
      `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');`
    );
  }

  const escapedData = escapeSqlLiteral(JSON.stringify(mergedData));
  scriptParts.push(
    `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';`,
    `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');`
  );

  scriptParts.push("COMMIT;");

  if (scriptParts.length <= 2) {
    warnings.push("Nothing to merge into state.vscdb.");
    return { merged: false, warnings };
  }

  if (dryRun) {
    return { merged: true, warnings };
  }

  await runSqliteScript(dbPath, scriptParts.join("\n") + "\n");
  return { merged: true, warnings };
}
