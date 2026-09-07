import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  isExecFileTimeoutError,
  listGlobalStateVscdbPaths,
  querySqliteRows,
  resolveStateDbCandidates,
} from "./transcripts-sqlite.js";
import { findStoreDbForConversation, resolveChatsRoot } from "./transcripts-cursor-paths.js";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
  decodeTranscriptArtifact,
} from "./transcript-bundle.js";
import { resolveComposerConversationTitle } from "./composer-title.js";
import {
  filterComposerDataForConversation,
  filterComposerHeadersForConversation,
} from "./chat-import-merge.js";
import { deriveComposerHeadersPayloadFromSidebarSnapshot } from "./composer-merge.js";
import {
  buildChatBundlesCollection,
  selectGistExportFile,
  defaultLocalExportFilename,
} from "./chat-bundle-format.js";
import type { ChatExportSelection } from "./chat-export-ux.js";
import {
  bundleArtifactsDebug,
  composerPayloadDebug,
  logChatRestoreDebug,
  resolveProjectsRoot,
  safeJsonParse,
} from "./chat-persistence-restore.js";
import { enumerateTranscriptFilesInConversation } from "./transcripts-discovery.js";
import { enrichBundleWithLiveDiskKv, exportDiskKvSnapshot } from "./chat-disk-kv-export.js";
import type { ChatBundle } from "./chat-persistence.js";
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import { formatDisplayPath } from "./chat-workspace-label.js";
import { resolveSyncRoots } from "./paths.js";

const SQLITE_READ_RETRIES = 3;

async function sourceFolderTildeForWorkspaceKey(
  workspaceKey: string | undefined,
  folderMap?: Map<string, string>
): Promise<string | undefined> {
  if (!workspaceKey) {
    return undefined;
  }
  const map =
    folderMap ?? (await buildChatsKeyToFolderMap(resolveSyncRoots().cursorUser));
  const folder = map.get(workspaceKey);
  return folder ? formatDisplayPath(folder) : undefined;
}

/** Transcript/sidebar/store + Layer 4 diskKv when present on global state.vscdb (schema v2). */
export async function buildChatBundle(
  _context: vscode.ExtensionContext,
  conversationId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options?: { workspaceKey?: string; folderMap?: Map<string, string> }
): Promise<{ bundle: ChatBundle; title: string; warnings: string[] }> {
  const warnings: string[] = [];

  progress.report({ message: "Locating store.db..." });
  let storeSnapshot: ChatBundle["storeSnapshot"] = null;
  let storeInfo: { absolutePath: string; workspaceKey: string } | undefined;
  if (options?.workspaceKey) {
    const candidate = path.join(
      resolveChatsRoot(),
      options.workspaceKey,
      conversationId,
      "store.db"
    );
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        storeInfo = { absolutePath: candidate, workspaceKey: options.workspaceKey };
      }
    } catch {}
  } else {
    storeInfo = await findStoreDbForConversation(conversationId);
  }
  if (storeInfo) {
    const raw = await fs.readFile(storeInfo.absolutePath);
    const checksum = computeArtifactChecksum(raw);
    storeSnapshot = {
      content: raw.toString("base64"),
      encoding: "base64",
      checksum,
      sizeBytes: raw.length,
      sourceWorkspaceKey: storeInfo.workspaceKey,
    };
  } else {
    warnings.push(
      options?.workspaceKey
        ? `store.db not found at ~/.cursor/chats/${options.workspaceKey}/${conversationId}/store.db; only transcripts will be saved.`
        : `store.db not found for conversation ${conversationId}; only transcripts will be saved.`
    );
  }

  progress.report({ message: "Reading sidebar metadata from state.vscdb..." });
  let sidebarSnapshot: Record<string, unknown> | null = null;
  const stateDbPaths = await resolveStateDbCandidates();
  if (stateDbPaths.length > 0) {
    try {
      const rows = await querySqliteRows(
        stateDbPaths[0]!,
        `SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');`,
        { retries: SQLITE_READ_RETRIES }
      );
      if (rows.length > 0) {
        const snapshot: Record<string, unknown> = { conversationId };
        for (const row of rows) {
          const key = String(row.key ?? "");
          const value = row.value;
          if (key === "composer.composerHeaders" || key === "composer.composerData") {
            snapshot[key.replace("composer.", "")] = typeof value === "string" ? safeJsonParse(value) : value;
          }
        }
        sidebarSnapshot = snapshot;
        const rawHeaders = snapshot.composerHeaders;
        if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
          const filtered = filterComposerHeadersForConversation(
            rawHeaders as Record<string, unknown>,
            conversationId
          );
          if (filtered.allComposers.length === 0) {
            warnings.push(
              `composer.composerHeaders has no row for conversation ${conversationId}; export may omit sidebar header metadata.`
            );
          }
          snapshot.composerHeaders = filtered;
        }
        const rawData = snapshot.composerData;
        if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
          snapshot.composerData = filterComposerDataForConversation(
            rawData as Record<string, unknown>,
            conversationId
          );
        }
      }
    } catch (err) {
      const isTimeout = isExecFileTimeoutError(err);
      warnings.push(
        isTimeout
          ? "state.vscdb timed out (database may be locked); sidebar metadata skipped."
          : `state.vscdb read failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    warnings.push("state.vscdb not found; sidebar metadata skipped.");
  }

  progress.report({ message: "Exporting composer disk KV (tool/MCP bubbles)..." });
  let diskKvSnapshot: ChatBundle["diskKvSnapshot"] = null;
  const globalDbPaths = await listGlobalStateVscdbPaths();
  const globalDbPath = globalDbPaths[0];
  if (globalDbPath) {
    try {
      diskKvSnapshot = await exportDiskKvSnapshot(globalDbPath, conversationId, {
        retries: SQLITE_READ_RETRIES,
      });
      if (!diskKvSnapshot) {
        warnings.push(
          `No cursorDiskKV rows for ${conversationId} in global state.vscdb; import will synthesize text-only composer bubbles (tool/MCP UI may show [REDACTED]). Open the chat in Composer on the source machine and re-export.`
        );
      }
    } catch (err) {
      const isTimeout = isExecFileTimeoutError(err);
      warnings.push(
        isTimeout
          ? "Global state.vscdb timed out during diskKv export; Layer 4 skipped."
          : `diskKv export failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    warnings.push("Global state.vscdb not found; diskKvSnapshot (Layer 4) skipped.");
  }

  progress.report({ message: "Collecting transcript files..." });
  const transcriptFiles: ChatBundle["transcriptFiles"] = [];
  const projectsRoot = resolveProjectsRoot();
  const maxTranscriptBytes = 256 * 1024 * 1024;
  try {
    const projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const projectDir = path.join(projectsRoot, dir.name);
      let entries;
      try {
        entries = await enumerateTranscriptFilesInConversation(
          projectDir,
          conversationId,
          maxTranscriptBytes
        );
      } catch {
        continue;
      }
      for (const entry of entries) {
        const raw = await fs.readFile(entry.absolutePath);
        const checksum = computeArtifactChecksum(raw);
        const encoded = encodeTranscriptArtifact(raw);
        transcriptFiles.push({
          relativePath: `${dir.name}/agent-transcripts/${entry.relativePath}`,
          content: encoded.content,
          encoding: encoded.encoding,
          checksum,
          sizeBytes: raw.length,
        });
      }
    }
  } catch {
    warnings.push("Could not enumerate transcript project directories.");
  }

  if (transcriptFiles.length === 0 && !storeSnapshot) {
    throw new Error(`No data found for conversation ${conversationId}. Check the ID and try again.`);
  }

  let transcriptContent: string | null = null;
  if (transcriptFiles.length > 0) {
    transcriptContent = decodeTranscriptArtifact(
      transcriptFiles[0]!.content,
      transcriptFiles[0]!.encoding
    ).toString("utf-8");
  }

  const title = await resolveComposerConversationTitle({
    conversationId,
    chatsWorkspaceKey: options?.workspaceKey,
    transcriptContent,
    bundle: sidebarSnapshot
      ? ({ conversationId, sidebarSnapshot } as ChatBundle)
      : undefined,
  });

  if (sidebarSnapshot) {
    const rawHeaders = sidebarSnapshot.composerHeaders;
    if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      const filtered = filterComposerHeadersForConversation(
        rawHeaders as Record<string, unknown>,
        conversationId
      );
      if (filtered.allComposers.length === 0) {
        const derived = deriveComposerHeadersPayloadFromSidebarSnapshot({
          conversationId,
          title,
          subtitle: `${transcriptFiles.length} file${transcriptFiles.length === 1 ? "" : "s"}`,
          lastUpdatedAt: new Date().toISOString(),
        });
        if (derived) {
          sidebarSnapshot.composerHeaders = derived;
        }
      }
    }
  }

  const sourceFolderTilde = await sourceFolderTildeForWorkspaceKey(
    options?.workspaceKey ?? storeInfo?.workspaceKey,
    options?.folderMap
  );

  const bundle: ChatBundle = {
    schemaVersion: diskKvSnapshot ? 2 : 1,
    type: "chat-persistence",
    createdAt: new Date().toISOString(),
    conversationId,
    title,
    subtitle: `${transcriptFiles.length} file${transcriptFiles.length === 1 ? "" : "s"}`,
    previewText: title,
    ...(sourceFolderTilde ? { sourceFolderTilde } : {}),
    sidebarSnapshot,
    storeSnapshot,
    transcriptFiles,
    ...(diskKvSnapshot ? { diskKvSnapshot } : {}),
  };

  logChatRestoreDebug(
    `buildChatBundle conversationId=${conversationId} ${bundleArtifactsDebug(bundle)} composerHeaders=${composerPayloadDebug(sidebarSnapshot?.composerHeaders as Record<string, unknown> | undefined)} composerData=${composerPayloadDebug(sidebarSnapshot?.composerData as Record<string, unknown> | undefined)} warnings=${warnings.length}`
  );

  return { bundle, title, warnings };
}

export async function buildChatExportPayload(
  context: vscode.ExtensionContext,
  selection: ChatExportSelection,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<{
  bundles: ChatBundle[];
  warnings: string[];
  gistPayload: { fileName: string; content: string };
  jsonForFile: string;
  defaultSaveBasename: string;
  primaryTitle: string;
}> {
  const bundles: ChatBundle[] = [];
  const warnings: string[] = [];
  for (const conversationId of selection.conversationIds) {
    const built = await buildChatBundle(context, conversationId, progress, {
      workspaceKey: selection.workspaceKey,
    });
    const { bundle: enriched, warnings: enrichW } = await enrichBundleWithLiveDiskKv(
      built.bundle,
      { retries: SQLITE_READ_RETRIES, extensionPath: context.extensionUri?.fsPath }
    );
    bundles.push(enriched);
    warnings.push(...built.warnings, ...enrichW);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let jsonForFile: string;
  let gistPayload: { fileName: string; content: string };
  if (bundles.length === 1) {
    gistPayload = selectGistExportFile(1, bundles[0]!);
    jsonForFile = gistPayload.content;
  } else {
    const collection = buildChatBundlesCollection(selection.workspaceKey, bundles);
    gistPayload = selectGistExportFile(bundles.length, collection);
    jsonForFile = gistPayload.content;
  }
  return {
    bundles,
    warnings,
    gistPayload,
    jsonForFile,
    defaultSaveBasename: defaultLocalExportFilename(
      selection.conversationIds,
      timestamp
    ),
    primaryTitle: bundles.length === 1 ? bundles[0]!.title : `${bundles.length} chats`,
  };
}
