import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type * as vscode from "vscode";
import { chatManifestFromBundle, hydrateGoldenStoreTemplate } from "./store-template-hydrate.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import { folderToProjectKey } from "./chat-workspace-context.js";
import { emitChatImportProgress } from "./chat-progress-events.js";
import {
  resolveTransportChatScript,
  runPythonDiskImport,
} from "./chat-transport-scripts.js";
import { enrichBundleWithLiveDiskKv } from "./chat-disk-kv-export.js";
import type { ChatBundle } from "./chat-persistence.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { logChatRestoreDebug } from "./chat-restore-debug.js";
import { applyProjectMappingToBundle } from "./chat-restore-mapping.js";
import { resolveChatPythonInterpreter } from "./chat-python.js";
import type { PythonSqliteInterpreter } from "./transcripts-sqlite.js";

let pythonInterpreterMemo: PythonSqliteInterpreter | null | undefined;

export async function ensurePythonReady(): Promise<string> {
  if (pythonInterpreterMemo !== undefined) {
    if (pythonInterpreterMemo === null) {
      throw new Error(
        "Python 3 not available; set cursorSync.chatImport.pythonPath or install python3."
      );
    }
    return pythonInterpreterMemo.command;
  }
  try {
    pythonInterpreterMemo = await resolveChatPythonInterpreter();
    return pythonInterpreterMemo.command;
  } catch {
    pythonInterpreterMemo = null;
    throw new Error(
      "Python 3 not available; set cursorSync.chatImport.pythonPath or install python3."
    );
  }
}

export async function ensureGoldenStoreDb(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  storeWorkspaceKey: string,
  dryRun: boolean
): Promise<{ storeWritten: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  if (bundle.storeSnapshot) {
    return { storeWritten: false, warnings };
  }

  const extensionRoot = context.extensionUri?.fsPath;
  if (!extensionRoot) {
    warnings.push(
      "Extension path unavailable; cannot synthesize store.db for activation."
    );
    return { storeWritten: false, warnings };
  }
  const templatePath = path.join(
    extensionRoot,
    "resources",
    "golden-chat-store.template.db"
  );
  try {
    await fs.access(templatePath);
  } catch {
    warnings.push(
      "Golden store template missing from extension; cannot synthesize store.db for activation."
    );
    return { storeWritten: false, warnings };
  }

  const storeDbPath = path.join(
    resolveChatsRoot(),
    storeWorkspaceKey,
    bundle.conversationId,
    "store.db"
  );

  if (dryRun) {
    logChatRestoreDebug(
      `[dry-run] would hydrate golden store.db at ${storeDbPath} from bundle transcripts`
    );
    return { storeWritten: true, warnings };
  }

  const chat = chatManifestFromBundle(bundle);
  const hw = await hydrateGoldenStoreTemplate({
    templatePath,
    outputPath: storeDbPath,
    chat,
  });
  warnings.push(...hw.warnings);
  warnings.push(
    "Synthesized store.db from golden template (bundle had no store.db snapshot)."
  );
  logChatRestoreDebug(
    `golden store.db hydrated conversationId=${bundle.conversationId} path=${storeDbPath}`
  );
  return { storeWritten: true, warnings };
}

/** @see AGENTS.md — writes store.db from golden template when export lacks store snapshot. */
export const ensureNativeChatStoreDb = ensureGoldenStoreDb;

function parseSidebarMergedFromPythonOutput(pyText: string): boolean {
  const match = pyText.match(/sidebar_merged=(true|false)/i);
  if (match?.[1]?.toLowerCase() === "true") {
    return true;
  }
  if (/Merged composer state into/i.test(pyText)) {
    return true;
  }
  if (/No sidebarSnapshot|sidebar merge skipped/i.test(pyText)) {
    return false;
  }
  return false;
}

export interface RestoreChatDiskResult {
  workingBundle: ChatBundle;
  remappedBundle: ChatBundle;
  transcriptsWritten: number;
  storeWritten: boolean;
  sidebarMerged: boolean;
  warnings: string[];
  extensionPath: string | undefined;
}

export async function restoreChatBundleDisk(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  wsCtx: WorkspaceContext,
  options: {
    projectMapping: Map<string, string>;
    workspaceStateDb: string;
    dryRun: boolean;
    syncGlobal: boolean;
    pinRecent: boolean;
    storeWorkspaceKey: string;
  }
): Promise<RestoreChatDiskResult> {
  const warnings: string[] = [];
  const conversationId = bundle.conversationId;

  try {
    await ensurePythonReady();
  } catch (err) {
    throw new Error(
      err instanceof Error ? err.message : "Python 3 not available; set cursorSync.chatImport.pythonPath or install python3."
    );
  }

  const extensionPath = context.extensionUri?.fsPath;
  const transportChatIo = await resolveTransportChatScript(
    "cursor_chat_io.py",
    extensionPath
  );
  if (!transportChatIo) {
    throw new Error(
      `transport-chat scripts not found in extension at ${extensionPath}. Reinstall Cursor Sync or set cursorSync.chatImport.transportChatScriptDir.`
    );
  }

  let workingBundle = bundle;
  const { bundle: diskKvEnriched, warnings: enrichWarnings } = await enrichBundleWithLiveDiskKv(
    workingBundle,
    { retries: 3, extensionPath }
  );
  workingBundle = diskKvEnriched;
  warnings.push(...enrichWarnings);

  const remappedBundle = applyProjectMappingToBundle(workingBundle, options.projectMapping);
  const tmpBundlePath = path.join(
    os.tmpdir(),
    `cursor-sync-import-${conversationId}-${Date.now()}.json`
  );
  let transcriptsWritten = 0;
  let storeWritten = false;
  let sidebarMerged = false;
  try {
    await fs.writeFile(tmpBundlePath, JSON.stringify(remappedBundle, null, 2), "utf8");
    emitChatImportProgress({ conversationId, phase: "A", step: "python-disk-import-start" });
    const diskOutcome = await runPythonDiskImport({
      bundlePath: tmpBundlePath,
      workspaceFolder: wsCtx.folderFsPath,
      targetProject:
        options.projectMapping.size > 0
          ? [...new Set(options.projectMapping.values())][0]
          : folderToProjectKey(wsCtx.folderFsPath),
      stateDbPath: options.workspaceStateDb,
      dryRun: options.dryRun,
      syncGlobal: options.syncGlobal,
      pinRecent: options.pinRecent,
      extensionPath,
      log: (line) => logChatRestoreDebug(line),
    });
    emitChatImportProgress({ conversationId, phase: "A", step: "python-disk-import-done", ok: diskOutcome.ok });
    if (!diskOutcome.ok) {
      throw new Error(
        `Disk import failed (transport-chat): exit ${diskOutcome.exitCode}. ${diskOutcome.stderr.trim() || diskOutcome.stdout.trim()}`
      );
    }
    transcriptsWritten = remappedBundle.transcriptFiles.length;
    storeWritten = !!remappedBundle.storeSnapshot;
    const pyText = `${diskOutcome.stdout}\n${diskOutcome.stderr}`;
    sidebarMerged = parseSidebarMergedFromPythonOutput(pyText);
    if (!storeWritten && !options.dryRun) {
      const golden = await ensureGoldenStoreDb(
        context,
        remappedBundle,
        options.storeWorkspaceKey,
        options.dryRun
      );
      storeWritten = golden.storeWritten;
      warnings.push(...golden.warnings);
    }
    logChatRestoreDebug(
      `disk restore via transport-chat conversationId=${conversationId} transcripts=${transcriptsWritten} store=${storeWritten}`
    );
  } finally {
    try {
      await fs.unlink(tmpBundlePath);
    } catch {
      /* ignore */
    }
  }

  if (workingBundle.storeSnapshot && !storeWritten) {
    throw new Error(
      "Bundle contained storeSnapshot but store.db was not written (required for import parity)."
    );
  }

  return {
    workingBundle,
    remappedBundle,
    transcriptsWritten,
    storeWritten,
    sidebarMerged,
    warnings,
    extensionPath,
  };
}
