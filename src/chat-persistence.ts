import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "./diagnostics.js";
import { createBackup, rollbackFromBackup, pruneOldBackups } from "./rollback.js";
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
  mergeTargetsForImport,
  mergeSidebarIntoStateDb,
  type WorkspaceIdentifier as MergeWorkspaceIdentifier,
} from "./chat-import-merge.js";
import { resolveSyncRoots } from "./paths.js";
import {
  pingServerProbe,
  runPostImportActivation,
} from "./chat-import-activate.js";
import {
  formatVerifyCheckLine,
  formatVerifyReport,
  runDiskAndActivationVerify,
  verifyActivationChecks,
  verifyChecksAllOk,
  type VerifyCheck,
} from "./chat-import-verify.js";
import {
  pickImportWorkspaceFolder,
  presentChatImportOutcome,
  promptChatImportOptions,
} from "./chat-import-ux.js";
import { humanWorkspaceLabel } from "./chat-workspace-label.js";

const {
  querySqliteRows,
  resolveStateDbCandidates,
  resolveChatsRoot,
  findStoreDbForConversation,
  isExecFileTimeoutError,
} = __chatPersistenceInternals;

/** Schema for locally-persisted chat bundle. */
export interface ChatBundle {
  schemaVersion: 1;
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
}

export interface SaveChatResult {
  bundlePath: string;
  conversationId: string;
  title: string;
  warnings: string[];
}

export interface LoadChatResult {
  conversationId: string;
  transcriptsWritten: number;
  storeWritten: boolean;
  storeWorkspaceKey?: string;
  sidebarMerged: boolean;
  warnings: string[];
  verifyChecks?: VerifyCheck[];
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

function logChatRestoreDebug(line: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] [chat-restore-debug] ${line}`);
}

function composerPayloadDebug(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return "absent";
  }
  const list = payload.allComposers;
  if (!Array.isArray(list)) {
    return "present keys=" + Object.keys(payload).join(",");
  }
  const ids = list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c))
    .map((c) => (typeof c.composerId === "string" ? c.composerId : ""))
    .filter((id) => id.length > 0);
  return `allComposers=${list.length} composerIds=[${ids.join(",")}]`;
}

function bundleArtifactsDebug(bundle: ChatBundle): string {
  const tfSummary =
    bundle.transcriptFiles.length === 0
      ? "none"
      : bundle.transcriptFiles
          .map((t) => `${path.basename(t.relativePath)}:${t.sizeBytes}b`)
          .join(",");
  const store = bundle.storeSnapshot
    ? `present ${bundle.storeSnapshot.sizeBytes}b src=${bundle.storeSnapshot.sourceWorkspaceKey}`
    : "absent";
  const sidebar = bundle.sidebarSnapshot
    ? `present keys=${Object.keys(bundle.sidebarSnapshot).join(",")}`
    : "absent";
  return `transcriptFiles=${bundle.transcriptFiles.length} [${tfSummary}] storeSnapshot=${store} sidebarSnapshot=${sidebar}`;
}

/**
 * Save a chat conversation to a local JSON bundle file.
 * Collects: store.db snapshot, sidebar metadata from state.vscdb, and transcript JSONL files.
 */
export async function executeSaveChatLocal(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const conversationId = await vscode.window.showInputBox({
    prompt: "Enter the conversation ID (folder name under agent-transcripts or chats)",
    placeHolder: "e.g. abc123-def456-...",
    ignoreFocusOut: true,
  });

  if (!conversationId || conversationId.trim().length === 0) {
    return;
  }

  const trimmedId = conversationId.trim();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Saving chat locally...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await saveChat(context, trimmedId, progress);

        let msg = `Chat "${result.title}" saved to ${path.basename(result.bundlePath)}`;
        if (result.warnings.length > 0) {
          msg += ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`;
        }
        vscode.window.showInformationMessage(msg);

        for (const w of result.warnings) {
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

  const conversationId = await vscode.window.showInputBox({
    prompt: "Enter the conversation ID to export",
    placeHolder: "e.g. abc123-def456-...",
    ignoreFocusOut: true,
  });

  if (!conversationId || conversationId.trim().length === 0) {
    return;
  }

  const trimmedId = conversationId.trim();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Exporting chat bundle...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const { bundle, title, warnings } = await buildChatBundle(
          context,
          trimmedId,
          progress
        );

        const safeName = trimmedId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
        const defaultUri = vscode.Uri.file(
          path.join(os.homedir(), "Downloads", `${safeName}-chat-bundle.json`)
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
        await fs.writeFile(saveUri.fsPath, JSON.stringify(bundle, null, 2), "utf-8");

        let msg = `Chat "${title}" exported to ${path.basename(saveUri.fsPath)}`;
        if (warnings.length > 0) {
          msg += ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`;
        }
        vscode.window.showInformationMessage(msg);

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
  try {
    const projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
      let files: string[];
      try {
        files = await fs.readdir(transcriptDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }
        const absPath = path.join(transcriptDir, file);
        const raw = await fs.readFile(absPath);
        const checksum = computeArtifactChecksum(raw);
        const encoded = encodeTranscriptArtifact(raw);
        transcriptFiles.push({
          relativePath: `${dir.name}/agent-transcripts/${conversationId}/${file}`,
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

async function saveChat(
  context: vscode.ExtensionContext,
  conversationId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<SaveChatResult> {
  const { bundle, title, warnings } = await buildChatBundle(context, conversationId, progress);

  progress.report({ message: "Writing bundle..." });
  const safeName = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundlePath = path.join(
    context.globalStorageUri.fsPath,
    "chat-bundles",
    `${safeName}_${timestamp}.json`
  );
  await fs.mkdir(path.dirname(bundlePath), { recursive: true });
  await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2), "utf-8");

  return { bundlePath, conversationId, title, warnings };
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
  const bundle = JSON.parse(raw) as ChatBundle;
  if (bundle.type !== "chat-persistence" || bundle.schemaVersion !== 1) {
    vscode.window.showErrorMessage("Invalid or unsupported chat bundle format.");
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

export async function restoreChatBundle(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options: RestoreChatBundleOptions = {}
): Promise<LoadChatResult> {
  if (bundle.type !== "chat-persistence" || bundle.schemaVersion !== 1) {
    throw new Error("Invalid or unsupported chat bundle format.");
  }

  const warnings: string[] = [];
  const verifyChecks: VerifyCheck[] = [];
  const conversationId = bundle.conversationId;
  let transcriptsWritten = 0;
  let storeWritten = false;
  let sidebarMerged = false;

  logChatRestoreDebug(
    `restoreChatBundle start conversationId=${conversationId} ${bundleArtifactsDebug(bundle)}`
  );

  progress.report({ message: "Resolving workspace..." });
  const folderFsPath =
    options.workspaceFolder?.trim() || (await pickImportWorkspaceFolder());
  if (!folderFsPath) {
    throw new Error(
      "Open a workspace folder in Cursor before importing a chat bundle (required for ~/.cursor/chats/<md5(folder)> store.db path)."
    );
  }
  const wsCtx = await requireWorkspaceContext({ workspaceFolder: folderFsPath });
  const storeWorkspaceKey = wsCtx.chatsWorkspaceKey;
  const dryRun = options.dryRun === true;
  const syncGlobal = options.syncGlobal !== false;
  const pinRecent = options.pinRecent !== false;
  logChatRestoreDebug(
    `workspace context folder=${wsCtx.folderFsPath} chatsKey=${storeWorkspaceKey} storageId=${wsCtx.workspaceStorageId} dryRun=${dryRun} activate=${!!options.activate}`
  );

  const sourceProjectKeys = new Set<string>();
  for (const tf of bundle.transcriptFiles) {
    const segments = tf.relativePath.split("/");
    if (segments.length > 0) {
      sourceProjectKeys.add(segments[0]!);
    }
  }

  const projectMapping: Map<string, string> = new Map();
  if (sourceProjectKeys.size > 0 && bundle.transcriptFiles.length > 0) {
    progress.report({ message: "Mapping projects..." });
    const mapping = await promptForTargetProject([...sourceProjectKeys].sort());
    if (mapping === null) {
      logChatRestoreDebug(`restoreChatBundle cancelled project mapping conversationId=${conversationId}`);
      return {
        conversationId,
        transcriptsWritten: 0,
        storeWritten: false,
        storeWorkspaceKey,
        sidebarMerged: false,
        warnings: ["Cancelled by user."],
      };
    }
    for (const [k, v] of mapping) {
      projectMapping.set(k, v);
    }
  }

  // Restore transcript JSONL files (remapped to target project)
  if (bundle.transcriptFiles.length > 0) {
    progress.report({ message: "Restoring transcript files..." });
    const projectsRoot = resolveProjectsRoot();
    for (const tf of bundle.transcriptFiles) {
      const decoded = decodeTranscriptArtifact(tf.content, tf.encoding);

      const actualChecksum = computeArtifactChecksum(decoded);
      if (actualChecksum !== tf.checksum) {
        warnings.push(`Checksum mismatch for ${tf.relativePath}; skipped.`);
        continue;
      }

      // Remap source project key to target project folder
      const segments = tf.relativePath.split("/");
      const sourceKey = segments[0]!;
      const mappedKey = projectMapping.get(sourceKey) ?? sourceKey;
      const remappedPath = [mappedKey, ...segments.slice(1)].join("/");
      const targetPath = path.join(projectsRoot, remappedPath);

      if (dryRun) {
        logChatRestoreDebug(
          `[dry-run] would write transcript ${targetPath} (${decoded.length} bytes)`
        );
        transcriptsWritten += 1;
        continue;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      const { entries: backupEntries } = await createBackup(context, [targetPath]);
      try {
        await fs.writeFile(targetPath, decoded);
        transcriptsWritten += 1;
      } catch (err) {
        await rollbackFromBackup(backupEntries);
        warnings.push(`Failed to write ${remappedPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logChatRestoreDebug(
      `transcripts restore done conversationId=${conversationId} written=${transcriptsWritten} of=${bundle.transcriptFiles.length}`
    );
  }

  if (bundle.storeSnapshot) {
    progress.report({ message: "Restoring store.db..." });
    const snap = bundle.storeSnapshot;
    const decoded = decodeTranscriptArtifact(snap.content, snap.encoding);

    const actualChecksum = computeArtifactChecksum(decoded);
    if (actualChecksum !== snap.checksum) {
      throw new Error("store.db checksum mismatch; import aborted.");
    }

    const chatsRoot = resolveChatsRoot();
    const storeDbPath = path.join(chatsRoot, storeWorkspaceKey, conversationId, "store.db");

    if (dryRun) {
      logChatRestoreDebug(
        `[dry-run] would write store ${storeDbPath} (${decoded.length} bytes)`
      );
      storeWritten = true;
    } else {
      await fs.mkdir(path.dirname(storeDbPath), { recursive: true });

      const { entries: backupEntries } = await createBackup(context, [storeDbPath]);
      try {
        await fs.writeFile(storeDbPath, decoded);
        storeWritten = true;
      } catch (err) {
        await rollbackFromBackup(backupEntries);
        throw new Error(
          `Failed to write store.db: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    logChatRestoreDebug(
      `store.db restore conversationId=${conversationId} storeWritten=${storeWritten} path=${storeDbPath} chatsKey=${storeWorkspaceKey}`
    );
  }

  if (bundle.storeSnapshot && !storeWritten) {
    throw new Error(
      "Bundle contained storeSnapshot but store.db was not written (required for import parity)."
    );
  }

  if (bundle.sidebarSnapshot) {
    progress.report({ message: "Merging sidebar state..." });
    const { cursorUser } = resolveSyncRoots();
    const workspaceStateDb = path.join(
      cursorUser,
      "workspaceStorage",
      wsCtx.workspaceStorageId,
      "state.vscdb"
    );
    const mergeTargets = await mergeTargetsForImport(workspaceStateDb, syncGlobal);
    logChatRestoreDebug(
      `sidebar merge conversationId=${conversationId} targets=${mergeTargets.length} [${mergeTargets.map((p) => path.basename(path.dirname(p)) + "/" + path.basename(p)).join(", ")}]`
    );

    if (mergeTargets.length === 0) {
      warnings.push("state.vscdb not found; sidebar merge skipped.");
    } else if (dryRun) {
      logChatRestoreDebug(
        `[dry-run] would merge sidebar into ${mergeTargets.length} state.vscdb target(s)`
      );
      sidebarMerged = mergeTargets.length > 0;
    } else {
      for (const dbPath of mergeTargets) {
        try {
          const { entries: backupEntries } = await createBackup(context, [dbPath]);
          try {
            const mergeResult = await mergeSidebarIntoStateDb(
              dbPath,
              bundle,
              wsCtx.workspaceIdentifier as unknown as MergeWorkspaceIdentifier,
              { pinRecent }
            );
            warnings.push(...mergeResult.warnings);
            if (mergeResult.merged) {
              sidebarMerged = true;
              logChatRestoreDebug(
                `sidebar merge success conversationId=${conversationId} db=${path.basename(dbPath)}`
              );
            }
          } catch (err) {
            await rollbackFromBackup(backupEntries);
            const errMsg = err instanceof Error ? err.message : String(err);
            warnings.push(`state.vscdb write failed for ${path.basename(dbPath)}: ${errMsg}; rolled back.`);
            logChatRestoreDebug(
              `sidebar merge failure conversationId=${conversationId} db=${path.basename(dbPath)} error=${errMsg}`
            );
          }
        } catch (err) {
          const isTimeout = isExecFileTimeoutError(err);
          const errMsg = err instanceof Error ? err.message : String(err);
          warnings.push(
            isTimeout
              ? `state.vscdb timed out for ${path.basename(dbPath)} (database may be locked).`
              : `state.vscdb merge failed for ${path.basename(dbPath)}: ${errMsg}`
          );
          logChatRestoreDebug(
            `sidebar merge error conversationId=${conversationId} db=${path.basename(dbPath)} timeout=${isTimeout} error=${errMsg}`
          );
        }
      }
    }
  }

  if (!dryRun) {
    progress.report({ message: "Verifying import..." });
    const diskChecks = await runDiskAndActivationVerify(conversationId, wsCtx, {
      bundle,
      postActivate: false,
    });
    verifyChecks.push(...diskChecks);
    for (const c of diskChecks) {
      logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
    }
    if (!verifyChecksAllOk(diskChecks)) {
      throw new Error(
        `Import verify failed (see verify lines above):\n${formatVerifyReport(diskChecks)}`
      );
    }

    if (options.activate) {
      progress.report({ message: "Activating composer..." });
      const activationOutcome = await runPostImportActivation(
        bundle,
        conversationId,
        wsCtx,
        {
          activateStrict: options.activateStrict,
          bridgeWaitResultMs: options.bridgeWaitResultMs,
          dryRun: false,
          extensionPath: context.extensionUri.fsPath,
          log: (line) => logChatRestoreDebug(line),
        }
      );
      if (
        options.activateStrict &&
        activationOutcome.stagedOnly &&
        !activationOutcome.ok
      ) {
        throw new Error(
          "Activation staged only (--activate-strict requires confirmed activation)"
        );
      }
      if (options.pingServer) {
        pingServerProbe(conversationId, (line) => logChatRestoreDebug(line));
      }
      progress.report({ message: "Verifying activation..." });
      const activationChecks = await verifyActivationChecks(conversationId);
      verifyChecks.push(...activationChecks);
      for (const c of activationChecks) {
        logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
      }
      if (!verifyChecksAllOk(activationChecks)) {
        throw new Error(
          `Activation verify failed:\n${formatVerifyReport(activationChecks)}`
        );
      }
    } else if (options.postActivate) {
      progress.report({ message: "Verifying activation..." });
      const activationChecks = await verifyActivationChecks(conversationId);
      verifyChecks.push(...activationChecks);
      for (const c of activationChecks) {
        logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
      }
      if (!verifyChecksAllOk(activationChecks)) {
        throw new Error(
          `Activation verify failed:\n${formatVerifyReport(activationChecks)}`
        );
      }
    }
  } else {
    logChatRestoreDebug("[dry-run] skipped disk and activation verify");
    if (options.activate) {
      await runPostImportActivation(bundle, conversationId, wsCtx, {
        activateStrict: options.activateStrict,
        bridgeWaitResultMs: options.bridgeWaitResultMs,
        dryRun: true,
        extensionPath: context.extensionUri.fsPath,
        log: (line) => logChatRestoreDebug(line),
      });
    }
    if (options.pingServer) {
      pingServerProbe(conversationId, (line) => logChatRestoreDebug(line));
    }
  }

  if (!dryRun) {
    await pruneOldBackups(context);
  }

  const result: LoadChatResult = {
    conversationId,
    transcriptsWritten,
    storeWritten,
    storeWorkspaceKey,
    sidebarMerged,
    warnings,
    verifyChecks: verifyChecks.length > 0 ? verifyChecks : undefined,
  };
  logChatRestoreDebug(
    `restoreChatBundle done conversationId=${conversationId} transcriptsWritten=${transcriptsWritten} storeWritten=${storeWritten} storeWorkspaceKey=${storeWorkspaceKey} sidebarMerged=${sidebarMerged} warnings=${warnings.length}${warnings.length > 0 ? ` [${warnings.join("; ")}]` : ""}`
  );
  return result;
}

async function loadChat(
  context: vscode.ExtensionContext,
  bundlePath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  restoreOptions: RestoreChatBundleOptions = restoreOptionsFromConfiguration()
): Promise<LoadChatResult> {
  progress.report({ message: "Reading bundle..." });
  const raw = await fs.readFile(bundlePath, "utf-8");
  const bundle = JSON.parse(raw) as ChatBundle;
  return restoreChatBundle(context, bundle, progress, restoreOptions);
}

function resolveProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function promptForTargetProject(sourceProjectKeys: string[]): Promise<Map<string, string> | null> {
  const projectsRoot = resolveProjectsRoot();
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    vscode.window.showErrorMessage(
      `Cannot read projects directory: ${projectsRoot}. Open a project in Cursor first.`
    );
    return null;
  }

  const localProjects = projectDirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found. Open a project in Cursor first to create a project directory."
    );
    return null;
  }

  const mapping = new Map<string, string>();

  for (const sourceKey of sourceProjectKeys) {
    const sourceLabel = humanWorkspaceLabel(sourceKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
      label: humanWorkspaceLabel(p.name),
      description: p.name,
      detail: path.join(projectsRoot, p.name),
    }));
    picks.unshift({ label: "(Skip)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" to a local project`,
      placeHolder: `Select the local project to receive chat transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      return null;
    }

    if (selected.description === "skip") {
      continue;
    }

    mapping.set(sourceKey, selected.description!);
  }

  return mapping;
}
