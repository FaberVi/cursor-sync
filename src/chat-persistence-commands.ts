import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "./diagnostics.js";
import { requireWorkspaceContext } from "./chat-workspace-context.js";
import {
  formatVerifyReport,
  runDiskAndActivationVerify,
  verifyChecksAllOk,
} from "./chat-import-verify.js";
import {
  pickImportWorkspaceFolder,
  presentChatImportOutcomeForBatch,
  promptChatImportOptions,
  restoreChatBundlesBatch,
} from "./chat-import-ux.js";
import {
  parseChatBundleOrCollection,
  resolveBundlesFromParsedExport,
} from "./chat-bundle-format.js";
import { pickChatsForExport, type ChatExportSelection } from "./chat-export-ux.js";
import {
  resolveChatEditorExportTarget,
  type ChatEditorExportTargetResolution,
} from "./chat-editor-target.js";
import { enrichImportResultWithBundleInspect } from "./chat-persistence-restore.js";
import { buildChatExportPayload } from "./chat-bundle-build.js";
import type { ChatBundle } from "./chat-persistence.js";

/**
 * Save a chat conversation to a local JSON bundle file.
 * Collects: store.db snapshot, sidebar metadata from state.vscdb, and transcript JSONL files.
 * Exports diskKvSnapshot (Layer 4) from global state.vscdb when cursorDiskKV rows exist.
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
        const basename = `cursor-chat_${timestamp}.json`;
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
  progressTitle: string,
  bundlePathOverride?: string
): Promise<void> {
  const logger = getLogger();

  let bundlePath = bundlePathOverride?.trim();
  if (!bundlePath) {
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
    bundlePath = uris[0]!.fsPath;
  }

  const promptResult = await promptChatImportOptions(importUx);
  if (!promptResult) {
    return;
  }

  let parsed: ReturnType<typeof parseChatBundleOrCollection>;
  try {
    const raw = await fs.readFile(bundlePath, "utf-8");
    parsed = parseChatBundleOrCollection(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.appendLine(`[${new Date().toISOString()}] [chat-load] FAILED: ${msg}`);
    vscode.window.showErrorMessage(`Chat import failed: ${msg}`);
    return;
  }

  const pickerShown =
    parsed.kind === "collection" && parsed.collection.bundles.length > 1;
  const bundles = await resolveBundlesFromParsedExport(parsed);
  if (!bundles) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: false,
    },
    async (progress) => {
      try {
        const batch = await restoreChatBundlesBatch(
          context,
          bundles,
          promptResult.restoreOptions,
          progress,
          "chat-load"
        );
        if (bundles.length === 1) {
          const bundle = bundles[0]!;
          for (let i = 0; i < batch.successes.length; i++) {
            batch.successes[i] = await enrichImportResultWithBundleInspect(
              context,
              bundlePath,
              bundle,
              batch.successes[i]!
            );
          }
        }
        await presentChatImportOutcomeForBatch(
          context,
          bundles,
          batch,
          promptResult.restoreOptions,
          "chat-load",
          pickerShown
        );
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
  context: vscode.ExtensionContext,
  bundlePath?: string
): Promise<void> {
  await executeImportChatBundleCore(
    context,
    {},
    "Importing chat bundle...",
    bundlePath
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

export function chatEditorExportFailureMessage(
  resolution: Exclude<ChatEditorExportTargetResolution, { ok: true }>
): string {
  if (resolution.reason === "not-chat") {
    return "Open or right-click a Cursor chat tab to export that chat.";
  }
  if (resolution.reason === "store-not-found") {
    return `Could not find local chat store for ${resolution.conversationId}.`;
  }
  return `Found chat ${resolution.conversationId} in multiple workspaces (${resolution.workspaceKeys.join(", ")}). Open the matching workspace and try again.`;
}

async function exportChatSelectionToBundleFile(
  context: vscode.ExtensionContext,
  selection: ChatExportSelection,
  progressTitle = "Exporting chat bundle..."
): Promise<void> {
  const logger = getLogger();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
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

export async function executeExportChatBundle(
  context: vscode.ExtensionContext
): Promise<void> {
  const selection = await pickChatsForExport();
  if (!selection) {
    return;
  }

  await exportChatSelectionToBundleFile(context, selection);
}

export async function executeExportCurrentChatBundle(
  context: vscode.ExtensionContext,
  target: unknown
): Promise<void> {
  const resolution = await resolveChatEditorExportTarget(target);
  if (!resolution.ok) {
    vscode.window.showWarningMessage(chatEditorExportFailureMessage(resolution));
    return;
  }

  await exportChatSelectionToBundleFile(context, {
    workspaceKey: resolution.target.workspaceKey,
    conversationIds: [resolution.target.conversationId],
  });
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
