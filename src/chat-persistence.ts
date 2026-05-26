import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "./diagnostics.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
  decodeTranscriptArtifact,
  summarizeTranscriptForSidebar,
  type TranscriptBundleArtifactEncoding,
} from "./transcript-bundle.js";
import { requireWorkspaceContext } from "./chat-workspace-context.js";
import {
  filterComposerDataForConversation,
  filterComposerHeadersForConversation,
} from "./chat-import-merge.js";
import {
  formatVerifyReport,
  runDiskAndActivationVerify,
  verifyChecksAllOk,
  type VerifyCheck,
} from "./chat-import-verify.js";
import {
  pickImportWorkspaceFolder,
  presentChatImportOutcome,
  promptChatImportOptions,
} from "./chat-import-ux.js";
import {
  buildChatBundlesCollection,
  selectGistExportFile,
  defaultLocalExportFilename,
  parseChatBundleOrCollection,
  pickBundleFromCollection,
} from "./chat-bundle-format.js";
import { pickChatsForExport, type ChatExportSelection } from "./chat-export-ux.js";
import {
  bundleArtifactsDebug,
  composerPayloadDebug,
  loadChat,
  logChatRestoreDebug,
  resolveProjectsRoot,
  safeJsonParse,
} from "./chat-persistence-restore.js";
import { enumerateTranscriptFilesInConversation } from "./transcripts-discovery.js";

export {
  ensurePythonReady,
  restoreChatBundle,
  __chatPersistenceTestUtils,
} from "./chat-persistence-restore.js";

const {
  querySqliteRows,
  resolveStateDbCandidates,
  resolveChatsRoot,
  findStoreDbForConversation,
  isExecFileTimeoutError,
} = __chatPersistenceInternals;

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

const SQLITE_READ_RETRIES = 3;

/**
 * Save a chat conversation to a local JSON bundle file.
 * Collects: store.db snapshot, sidebar metadata from state.vscdb, and transcript JSONL files.
 * Does not export diskKvSnapshot (Layer 4); bundled Python export is authoritative until parity.
 */
export async function executeSaveChatLocal(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const selection = await pickChatsForExport();
  if (!selection) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Saving chat locally...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const { jsonForFile, warnings, primaryTitle, bundles } = await buildChatExportPayload(
          context,
          selection,
          progress
        );
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const multi = bundles.length > 1;
        const basename = multi
          ? `chat-bundles_${timestamp}.json`
          : `${selection.conversationIds[0]!.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60)}_${timestamp}.json`;
        const bundlePath = path.join(context.globalStorageUri.fsPath, "chat-bundles", basename);
        await fs.mkdir(path.dirname(bundlePath), { recursive: true });
        await fs.writeFile(bundlePath, jsonForFile, "utf-8");

        const msg =
          bundles.length === 1
            ? `Chat "${primaryTitle}" saved to ${path.basename(bundlePath)}`
            : `${bundles.length} chats saved to ${path.basename(bundlePath)}`;
        if (warnings.length > 0) {
          vscode.window.showInformationMessage(
            `${msg} (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`
          );
        } else {
          vscode.window.showInformationMessage(msg);
        }

        for (const w of warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-save] ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [chat-save] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat save failed: ${msg}`);
      }
    }
  );
}

/**
 * Load a chat from a local JSON bundle file.
 * Restores: store.db, sidebar metadata into state.vscdb, and transcript JSONL files.
 */
async function executeImportChatBundleCore(
  context: vscode.ExtensionContext,
  importUx: { forceActivate?: boolean; skipActivatePrompt?: boolean },
  progressTitle: string
): Promise<void> {
  const logger = getLogger();

  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "Chat Bundle": ["json"] },
    title: "Select chat bundle to import",
  });

  if (!uris || uris.length === 0) {
    return;
  }

  const promptResult = await promptChatImportOptions(importUx);
  if (!promptResult) {
    return;
  }

  const bundlePath = uris[0]!.fsPath;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await loadChat(
          context,
          bundlePath,
          progress,
          promptResult.restoreOptions
        );
        await presentChatImportOutcome(result, promptResult.restoreOptions, "chat-load");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [chat-load] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat import failed: ${msg}`);
      }
    }
  );
}

export async function executeLoadChatLocal(
  context: vscode.ExtensionContext
): Promise<void> {
  await executeImportChatBundleCore(
    context,
    {},
    "Loading chat from bundle..."
  );
}

export async function executeImportChatBundle(
  context: vscode.ExtensionContext
): Promise<void> {
  await executeImportChatBundleCore(
    context,
    {},
    "Importing chat bundle..."
  );
}

export async function executeImportChatBundleActivate(
  context: vscode.ExtensionContext
): Promise<void> {
  await executeImportChatBundleCore(
    context,
    { forceActivate: true },
    "Importing chat bundle with activation..."
  );
}

export async function executeExportChatBundle(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const selection = await pickChatsForExport();
  if (!selection) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Exporting chat bundle...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const { jsonForFile, warnings, primaryTitle, bundles, defaultSaveBasename } =
          await buildChatExportPayload(context, selection, progress);

        const defaultUri = vscode.Uri.file(
          path.join(os.homedir(), "Downloads", defaultSaveBasename)
        );
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { "Chat Bundle": ["json"] },
          title: "Save chat bundle as",
        });

        if (!saveUri) {
          return;
        }

        progress.report({ message: "Writing bundle..." });
        await fs.mkdir(path.dirname(saveUri.fsPath), { recursive: true });
        await fs.writeFile(saveUri.fsPath, jsonForFile, "utf-8");

        const msg =
          bundles.length === 1
            ? `Chat "${primaryTitle}" exported to ${path.basename(saveUri.fsPath)}`
            : `${bundles.length} chats exported to ${path.basename(saveUri.fsPath)}`;
        if (warnings.length > 0) {
          vscode.window.showInformationMessage(
            `${msg} (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`
          );
        } else {
          vscode.window.showInformationMessage(msg);
        }

        for (const w of warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-export] ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [chat-export] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat export failed: ${msg}`);
      }
    }
  );
}

/** Transcript/sidebar/store only; schema v1. Layer 4 uses Python `build_bundle` (schema v2). */
export async function buildChatBundle(
  _context: vscode.ExtensionContext,
  conversationId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options?: { workspaceKey?: string }
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

  // Derive title from transcript content or fallback to ID
  let title = conversationId;
  if (transcriptFiles.length > 0) {
    const firstContent = decodeTranscriptArtifact(
      transcriptFiles[0]!.content,
      transcriptFiles[0]!.encoding
    ).toString("utf-8");
    const summary = summarizeTranscriptForSidebar(firstContent, conversationId);
    title = summary.title;
  }

  const bundle: ChatBundle = {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt: new Date().toISOString(),
    conversationId,
    title,
    subtitle: `${transcriptFiles.length} file${transcriptFiles.length === 1 ? "" : "s"}`,
    previewText: title,
    sidebarSnapshot,
    storeSnapshot,
    transcriptFiles,
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
    const { bundle, warnings: w } = await buildChatBundle(context, conversationId, progress, {
      workspaceKey: selection.workspaceKey,
    });
    bundles.push(bundle);
    warnings.push(...w);
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

export async function executeVerifyChatImport(
  _context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "Chat Bundle": ["json"] },
    title: "Select chat bundle to verify",
  });

  if (!uris || uris.length === 0) {
    return;
  }

  const bundlePath = uris[0]!.fsPath;
  const raw = await fs.readFile(bundlePath, "utf-8");
  let bundle: ChatBundle;
  try {
    const parsed = parseChatBundleOrCollection(raw);
    if (parsed.kind === "collection") {
      vscode.window.showErrorMessage(
        "Select a single chat bundle for verify, or pick one conversation from a multi-chat export file."
      );
      return;
    }
    bundle = parsed.bundle;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Invalid or unsupported chat bundle format: ${msg}`);
    return;
  }

  const folderFsPath = await pickImportWorkspaceFolder();
  if (!folderFsPath) {
    vscode.window.showErrorMessage(
      "Open a workspace folder in Cursor before verifying a chat import."
    );
    return;
  }

  const postPick = await vscode.window.showQuickPick(
    [
      { label: "Disk checks only", postActivate: false },
      { label: "Disk + activation checks", postActivate: true },
    ],
    {
      title: "Verify scope",
      placeHolder: "Include post-activate checks (pending.json, result.json)?",
    }
  );
  if (!postPick) {
    return;
  }

  try {
    const wsCtx = await requireWorkspaceContext({ workspaceFolder: folderFsPath });
    const checks = await runDiskAndActivationVerify(bundle.conversationId, wsCtx, {
      bundle,
      postActivate: postPick.postActivate,
    });
    const report = formatVerifyReport(checks);
    for (const line of report.split("\n")) {
      logger.appendLine(`[${new Date().toISOString()}] [chat-verify] ${line}`);
    }
    if (!verifyChecksAllOk(checks)) {
      vscode.window.showErrorMessage(
        `Chat import verify failed (${checks.filter((c) => c.status === "FAIL").length} FAIL). See Cursor Sync output.`
      );
      return;
    }
    vscode.window.showInformationMessage(
      `Chat import verify passed (${checks.length} check${checks.length === 1 ? "" : "s"}). See Cursor Sync output.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.appendLine(`[${new Date().toISOString()}] [chat-verify] FAILED: ${msg}`);
    vscode.window.showErrorMessage(`Chat verify failed: ${msg}`);
  }
}
