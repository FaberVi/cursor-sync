import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { resolveSyncRoots } from "./paths.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import { agentDebugLog } from "./debug-session-log.js";

const { querySqliteRows } = __chatPersistenceInternals;

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
  const text = typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function workspaceIdFromRecord(rec: Record<string, unknown> | undefined): string | null {
  const wi = rec?.workspaceIdentifier;
  if (!wi || typeof wi !== "object" || Array.isArray(wi)) {
    return null;
  }
  const id = (wi as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function fsPathFromRecord(rec: Record<string, unknown> | undefined): string | null {
  const wi = rec?.workspaceIdentifier;
  if (!wi || typeof wi !== "object" || Array.isArray(wi)) {
    return null;
  }
  const uri = (wi as Record<string, unknown>).uri;
  if (!uri || typeof uri !== "object" || Array.isArray(uri)) {
    return null;
  }
  const fsPath = (uri as Record<string, unknown>).fsPath;
  return typeof fsPath === "string" ? fsPath : null;
}

function headerFields(ent: Record<string, unknown>): Record<string, unknown> {
  return {
    name: ent.name ?? null,
    createdAt: ent.createdAt ?? null,
    lastUpdatedAt: ent.lastUpdatedAt ?? null,
    lastOpenedAt: ent.lastOpenedAt ?? null,
    type: ent.type ?? null,
    isArchived: ent.isArchived ?? null,
    isDraft: ent.isDraft ?? null,
  };
}

function blobFields(blob: Record<string, unknown>): Record<string, unknown> {
  return {
    name: blob.name ?? null,
    createdAt: blob.createdAt ?? null,
    lastUpdatedAt: blob.lastUpdatedAt ?? null,
    lastOpenedAt: blob.lastOpenedAt ?? null,
    status: blob.status ?? null,
    fullHeadersLen: Array.isArray(blob.fullConversationHeadersOnly)
      ? blob.fullConversationHeadersOnly.length
      : 0,
    conversationMapLen:
      blob.conversationMap &&
      typeof blob.conversationMap === "object" &&
      !Array.isArray(blob.conversationMap)
        ? Object.keys(blob.conversationMap as object).length
        : 0,
  };
}

export async function probeComposerSidebarDiskState(
  conversationId: string,
  wsCtx: WorkspaceContext,
  location: string,
  hypothesisId: string,
  runId = "repro"
): Promise<Record<string, unknown>> {
  const { cursorUser } = resolveSyncRoots();
  const globalDb = path.join(cursorUser, "globalStorage", "state.vscdb");
  const wsDb = path.join(
    cursorUser,
    "workspaceStorage",
    wsCtx.workspaceStorageId,
    "state.vscdb"
  );
  const expectedWorkspaceId = wsCtx.workspaceIdentifier.id;
  const probe: Record<string, unknown> = {
    conversationId,
    expectedWorkspaceId,
    expectedWorkspaceStorageId: wsCtx.workspaceStorageId,
    expectedFolderFsPath: wsCtx.folderFsPath,
  };

  const openFolders =
    vscode.workspace.workspaceFolders?.map((f) => path.resolve(f.uri.fsPath)) ?? [];
  probe.openWorkspaceFolders = openFolders;
  probe.importFolderMatchesOpen = openFolders.some(
    (f) => f === path.resolve(wsCtx.folderFsPath)
  );

  async function headerProbe(dbPath: string, label: string): Promise<void> {
    try {
      const rows = await querySqliteRows(
        dbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerHeaders' LIMIT 1",
        { retries: 1 }
      );
      const parsed = parseJsonRecord(rows[0]?.value);
      if (!parsed) {
        probe[`${label}.headers`] = "missing-or-empty";
        return;
      }
      const list = parsed.allComposers;
      if (!Array.isArray(list)) {
        probe[`${label}.headers`] = "no-allComposers";
        return;
      }
      probe[`${label}.allComposersCount`] = list.length;
      const ent = list.find(
        (e): e is Record<string, unknown> =>
          !!e && typeof e === "object" && !Array.isArray(e) && e.composerId === conversationId
      );
      if (!ent) {
        probe[`${label}.conversationInHeaders`] = false;
        return;
      }
      probe[`${label}.conversationInHeaders`] = true;
      probe[`${label}.headerWorkspaceId`] = workspaceIdFromRecord(ent);
      probe[`${label}.headerFsPath`] = fsPathFromRecord(ent);
      probe[`${label}.header`] = headerFields(ent);
      probe[`${label}.headerWorkspaceMatchesExpected`] =
        workspaceIdFromRecord(ent) === expectedWorkspaceId;
    } catch (err) {
      probe[`${label}.headersError`] = err instanceof Error ? err.message : String(err);
    }
  }

  async function composerDataProbe(dbPath: string, label: string): Promise<void> {
    try {
      const rows = await querySqliteRows(
        dbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerData' LIMIT 1",
        { retries: 1 }
      );
      const parsed = parseJsonRecord(rows[0]?.value);
      if (!parsed) {
        probe[`${label}.composerData`] = "missing-or-empty";
        return;
      }
      const blob = parsed[conversationId];
      if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
        probe[`${label}.composerData`] = "no-blob";
        return;
      }
      const rec = blob as Record<string, unknown>;
      probe[`${label}.blobWorkspaceId`] = workspaceIdFromRecord(rec);
      probe[`${label}.blobFsPath`] = fsPathFromRecord(rec);
      probe[`${label}.blob`] = blobFields(rec);
      probe[`${label}.blobWorkspaceMatchesExpected`] =
        workspaceIdFromRecord(rec) === expectedWorkspaceId;
    } catch (err) {
      probe[`${label}.composerDataError`] = err instanceof Error ? err.message : String(err);
    }
  }

  await headerProbe(globalDb, "global");
  await headerProbe(wsDb, "workspace");
  await composerDataProbe(globalDb, "global");
  await composerDataProbe(wsDb, "workspace");

  const globalHeaderId = probe["global.headerWorkspaceId"];
  const globalBlobId = probe["global.blobWorkspaceId"];
  probe.globalHeaderBlobWorkspaceMismatch =
    typeof globalHeaderId === "string" &&
    typeof globalBlobId === "string" &&
    globalHeaderId !== globalBlobId;
  probe.globalHeaderHiddenByWorkspaceFilter =
    probe["global.conversationInHeaders"] === true &&
    probe["global.headerWorkspaceMatchesExpected"] === false;

  // #region agent log
  agentDebugLog(hypothesisId, location, "composer sidebar disk probe", probe, runId);
  // #endregion

  return probe;
}
