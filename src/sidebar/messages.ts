import * as vscode from "vscode";
import { clearImports } from "./import-history.js";

export type SidebarMessage =
  | { command: "syncNow" | "push" | "pull" | "export" | "import" | "configure" }
  | { command: "chats:listLocal" }
  | { command: "chats:loadGroup"; projectKey: string }
  | { command: "chats:listImports" }
  | { command: "chats:listBundles" }
  | { command: "chats:export"; conversationId: string }
  | { command: "chats:exportGist"; conversationId: string }
  | { command: "chats:importBundle"; bundlePath?: string }
  | {
      command: "chats:open";
      conversationId: string;
      workspaceKey?: string;
      projectKey?: string;
      backupTier?: string;
    }
  | {
      command: "chats:revealFiles";
      conversationId: string;
      workspaceKey?: string;
      projectKey?: string;
    }
  | {
      command: "chats:reactivate";
      conversationId: string;
      workspaceKey?: string;
      projectKey?: string;
      backupTier?: string;
    }
  | { command: "chats:revealTranscripts"; conversationId: string; workspaceKey?: string; projectKey?: string }
  | { command: "chats:clearHistory" }
  | { command: "settings:get" }
  | { command: "settings:set"; key: string; value: unknown };

export async function dispatchSidebarMessage(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  msg: SidebarMessage
): Promise<void> {
  switch (msg.command) {
    case "syncNow":
      await vscode.commands.executeCommand("cursorSync.syncNow");
      break;
    case "push":
      await vscode.commands.executeCommand("cursorSync.push");
      break;
    case "pull":
      await vscode.commands.executeCommand("cursorSync.pull");
      break;
    case "export":
      await vscode.commands.executeCommand("cursorSync.export");
      break;
    case "import":
      await vscode.commands.executeCommand("cursorSync.import");
      break;
    case "configure":
      await vscode.commands.executeCommand("cursorSync.configureGithub");
      break;
    case "chats:listLocal": {
      const { listLocalConversationsGrouped } = await import("./chats-tab.js");
      const result = await listLocalConversationsGrouped();
      await webview.postMessage({
        type: "chats:grouped",
        groups: result.groups,
        totalConversations: result.totalConversations,
      });
      break;
    }
    case "chats:loadGroup": {
      const { loadConversationGroupRows } = await import("./chats-tab.js");
      const rows = await loadConversationGroupRows(msg.projectKey);
      await webview.postMessage({
        type: "chats:groupRows",
        projectKey: msg.projectKey,
        rows,
      });
      break;
    }
    case "chats:listImports": {
      const { listImportHistory } = await import("./chats-tab.js");
      const result = listImportHistory(context);
      await webview.postMessage({ type: "chats:imports", rows: result.rows });
      break;
    }
    case "chats:listBundles": {
      const { listBundles } = await import("./chats-tab.js");
      const result = await listBundles(context);
      await webview.postMessage({ type: "chats:bundles", entries: result.entries });
      break;
    }
    case "chats:export":
      await vscode.commands.executeCommand("cursorSync.exportChatBundle");
      break;
    case "chats:exportGist":
      await vscode.commands.executeCommand("cursorSync.exportChatToGist");
      break;
    case "chats:importBundle":
      await vscode.commands.executeCommand(
        "cursorSync.importChatBundle",
        msg.bundlePath
      );
      break;
    case "chats:open":
    case "chats:reactivate": {
      const conversationId = msg.conversationId;
      try {
        const folders = vscode.workspace.workspaceFolders;
        if (!conversationId) {
          void vscode.window.showWarningMessage("Missing conversation id for Open.");
        } else if (!folders || folders.length === 0) {
          void vscode.window.showWarningMessage("Open a workspace folder first.");
        } else {
          try {
            const { openConversation } = await import("./chats-tab.js");
            await openConversation(context, conversationId, {
              workspaceKey: msg.workspaceKey,
              projectKey: msg.projectKey,
              backupTier: msg.backupTier,
            });
          } catch (err) {
            void vscode.window.showErrorMessage(`Could not open chat: ${String(err)}`);
          }
        }
      } finally {
        if (conversationId) {
          await webview.postMessage({
            type: "chats:openComplete",
            conversationId,
          });
        }
      }
      break;
    }
    case "chats:revealFiles":
    case "chats:revealTranscripts": {
      if (!msg.conversationId) {
        void vscode.window.showWarningMessage("Missing conversation id for Files.");
        break;
      }
      try {
        const { revealConversationFiles } = await import("./chats-tab.js");
        await revealConversationFiles(msg.conversationId, msg.workspaceKey, msg.projectKey);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not reveal files: ${String(err)}`);
      }
      break;
    }
    case "chats:clearHistory":
      await clearImports(context);
      await webview.postMessage({ type: "chats:history-cleared" });
      break;
    case "settings:get": {
      const { readSettingsValues } = await import("./settings-tab.js");
      const values = readSettingsValues();
      await webview.postMessage({ type: "settings:current", values });
      break;
    }
    case "settings:set": {
      const { updateSettingValue, readSettingsValues } = await import("./settings-tab.js");
      await updateSettingValue(msg.key, msg.value);
      await webview.postMessage({ type: "settings:current", values: readSettingsValues() });
      if (msg.key === "chats.syncEnabled") {
        const { refreshSidebar } = await import("./index.js");
        refreshSidebar();
      }
      break;
    }
    default:
      break;
  }
}
