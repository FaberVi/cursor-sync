import * as vscode from "vscode";
import type { ChatBundle, LoadChatResult, RestoreChatBundleOptions } from "./chat-persistence.js";
import { resolveWorkspaceContext } from "./chat-workspace-context.js";
import { runPostImportActivation } from "./chat-import-activate.js";
import { getLogger } from "./diagnostics.js";

export async function maybeActivateChatsAfterPull(
  context: vscode.ExtensionContext,
  importedBundles: ChatBundle[],
  successes: LoadChatResult[],
  restoreOptions: RestoreChatBundleOptions
): Promise<void> {
  if (importedBundles.length === 0 || successes.length === 0) {
    return;
  }
  if (restoreOptions.activate) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Imported ${successes.length} chat(s) from sync. Activate in Composer now?`,
    "Activate",
    "Later"
  );
  if (choice !== "Activate") {
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage("Open a workspace folder to activate imported chats.");
    return;
  }

  const logger = getLogger();
  const bundleById = new Map(importedBundles.map((b) => [b.conversationId, b]));
  const wsCtx = await resolveWorkspaceContext({
    workspaceFolder: folders[0]!.uri.fsPath,
  });
  if (!wsCtx) {
    void vscode.window.showWarningMessage("Could not resolve workspace context for activation.");
    return;
  }

  for (const success of successes) {
    const bundle = bundleById.get(success.conversationId);
    if (!bundle) {
      continue;
    }
    try {
      const outcome = await runPostImportActivation(bundle, success.conversationId, wsCtx, {
        activateStrict: restoreOptions.activateStrict ?? false,
        bridgeWaitResultMs: restoreOptions.bridgeWaitResultMs ?? 0,
        extensionPath: context.extensionUri?.fsPath,
        log: (message) => logger.appendLine(message),
      });
      if (!outcome.ok || outcome.stagedOnly) {
        logger.appendLine(
          `[chat-pull-activation] activation incomplete conversationId=${success.conversationId} exitCode=${outcome.exitCode} stagedOnly=${outcome.stagedOnly}`
        );
      }
    } catch (err) {
      logger.appendLine(
        `[chat-pull-activation] fail conversationId=${success.conversationId}: ${String(err)}`
      );
    }
  }
}
