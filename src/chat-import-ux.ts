import * as path from "node:path";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import {
  formatVerifyCheckLine,
  formatVerifyReport,
  type VerifyCheck,
} from "./chat-import-verify.js";
import {
  restoreOptionsFromConfiguration,
  type LoadChatResult,
  type RestoreChatBundleOptions,
} from "./chat-persistence.js";

export interface ChatImportPromptResult {
  workspaceFolder: string;
  restoreOptions: RestoreChatBundleOptions;
}

export async function pickImportWorkspaceFolder(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  if (folders.length === 1) {
    return folders[0]!.uri.fsPath;
  }
  const picks: vscode.QuickPickItem[] = folders.map((f) => ({
    label: path.basename(f.uri.fsPath),
    description: f.uri.fsPath,
  }));
  const selected = await vscode.window.showQuickPick(picks, {
    title: "Select workspace folder for chat import",
    placeHolder: "store.db is written under ~/.cursor/chats/<md5(this folder)>/",
    ignoreFocusOut: true,
  });
  return selected?.description ?? null;
}

async function promptActivateChoice(
  defaultActivate: boolean
): Promise<boolean | null> {
  type ActivatePick = vscode.QuickPickItem & { activate: boolean };
  const items: ActivatePick[] = [
    {
      label: "Activate composer after import",
      description: "Runs composer.createComposer (import-v2)",
      activate: true,
    },
    {
      label: "Disk restore only",
      description: "Layers 1–3 only; no IDE activation",
      activate: false,
    },
  ];
  const selected = await vscode.window.showQuickPick(items, {
    title: "Chat import activation",
    placeHolder: defaultActivate
      ? "Default: activate (cursorSync.chatImport.activateDefault)"
      : "Default: disk only (cursorSync.chatImport.activateDefault)",
    ignoreFocusOut: true,
  });
  if (!selected) {
    return null;
  }
  return selected.activate;
}

export async function promptChatImportOptions(options?: {
  forceActivate?: boolean;
  skipActivatePrompt?: boolean;
}): Promise<ChatImportPromptResult | null> {
  const folderFsPath = await pickImportWorkspaceFolder();
  if (!folderFsPath) {
    vscode.window.showErrorMessage(
      "Open a workspace folder in Cursor before importing a chat bundle."
    );
    return null;
  }

  const restoreOptions: RestoreChatBundleOptions = {
    ...restoreOptionsFromConfiguration(),
    workspaceFolder: folderFsPath,
  };

  if (options?.forceActivate) {
    restoreOptions.activate = true;
    return { workspaceFolder: folderFsPath, restoreOptions };
  }

  if (options?.skipActivatePrompt) {
    return { workspaceFolder: folderFsPath, restoreOptions };
  }

  const activateChoice = await promptActivateChoice(restoreOptions.activate === true);
  if (activateChoice === null) {
    return null;
  }
  restoreOptions.activate = activateChoice;
  return { workspaceFolder: folderFsPath, restoreOptions };
}

export function formatVerifySummary(checks: VerifyCheck[] | undefined): string {
  if (!checks || checks.length === 0) {
    return "";
  }
  const ok = checks.filter((c) => c.status === "OK").length;
  const warn = checks.filter((c) => c.status === "WARN").length;
  const fail = checks.filter((c) => c.status === "FAIL").length;
  const pending = checks.filter((c) => c.status === "PENDING").length;
  const skip = checks.filter((c) => c.status === "SKIP").length;
  const parts: string[] = [`verify ${checks.length} checks`];
  if (ok > 0) {
    parts.push(`${ok} OK`);
  }
  if (warn > 0) {
    parts.push(`${warn} WARN`);
  }
  if (fail > 0) {
    parts.push(`${fail} FAIL`);
  }
  if (pending > 0) {
    parts.push(`${pending} PENDING`);
  }
  if (skip > 0) {
    parts.push(`${skip} SKIP`);
  }
  return parts.join(", ");
}

export function buildChatImportResultMessage(
  result: LoadChatResult,
  restoreOptions: RestoreChatBundleOptions
): string {
  const parts: string[] = [`Chat "${result.conversationId}" loaded.`];
  if (result.transcriptsWritten > 0) {
    parts.push(
      `${result.transcriptsWritten} transcript file${result.transcriptsWritten === 1 ? "" : "s"}`
    );
  }
  if (result.storeWritten) {
    parts.push("store.db restored");
  }
  if (result.sidebarMerged) {
    parts.push("sidebar merged");
  }
  if (restoreOptions.activate) {
    parts.push("activation requested");
  }
  const verifySummary = formatVerifySummary(result.verifyChecks);
  if (verifySummary) {
    parts.push(verifySummary);
  }
  if (result.warnings.length > 0) {
    parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
  }
  return parts.join(" | ");
}

export async function presentChatImportOutcome(
  result: LoadChatResult,
  restoreOptions: RestoreChatBundleOptions,
  logTag: "chat-load" | "gist-chat-import"
): Promise<void> {
  const logger = getLogger();
  const message = buildChatImportResultMessage(result, restoreOptions);
  vscode.window.showInformationMessage(message);

  if (result.verifyChecks && result.verifyChecks.length > 0) {
    const report = formatVerifyReport(result.verifyChecks);
    for (const line of report.split("\n")) {
      logger.appendLine(`[${new Date().toISOString()}] [${logTag}] verify: ${line}`);
    }
    for (const check of result.verifyChecks) {
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-restore-debug] verify: ${formatVerifyCheckLine(check)}`
      );
    }
  }

  const config = vscode.workspace.getConfiguration("cursorSync");
  const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
  if (autoReload) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } else {
    const reloadAction = "Reload Window";
    const choice = await vscode.window.showInformationMessage(
      "Cursor may need a reload to reflect imported chat in the sidebar.",
      reloadAction
    );
    if (choice === reloadAction) {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }

  for (const w of result.warnings) {
    logger.appendLine(`[${new Date().toISOString()}] [${logTag}] ${w}`);
  }
}
