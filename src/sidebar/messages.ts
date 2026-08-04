import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { clearImports } from "./import-history.js";
import { emitSyncActionsIdle } from "../sync-progress-events.js";
import {
  isComposerConversationId,
  isSafePathSegment,
} from "../composer-id.js";
import { t } from "./i18n.js";
import { resolveSyncRoots } from "../paths.js";
import { syncKeyToAbsolutePath } from "../sync-local-deletes.js";

export type SidebarMessage =
  | {
      command: "syncNow" | "push" | "pull" | "export" | "import" | "configure";
      destination?: {
        type?: string;
        repo?: string;
        branch?: string;
        path?: string;
      };
    }
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
  | { command: "history:details"; timestamp: string }
  | { command: "history:page"; page: number }
  | { command: "settings:get" }
  | { command: "settings:set"; key: string; value: unknown };

const KNOWN_COMMANDS = new Set<string>([
  "syncNow",
  "push",
  "pull",
  "export",
  "import",
  "configure",
  "chats:listLocal",
  "chats:loadGroup",
  "chats:listImports",
  "chats:listBundles",
  "chats:export",
  "chats:exportGist",
  "chats:importBundle",
  "chats:open",
  "chats:revealFiles",
  "chats:reactivate",
  "chats:revealTranscripts",
  "chats:clearHistory",
  "history:details",
  "history:page",
  "settings:get",
  "settings:set",
]);

function assertSafeChatIds(msg: {
  conversationId?: string;
  workspaceKey?: string;
  projectKey?: string;
}): string | undefined {
  if (msg.conversationId !== undefined && msg.conversationId !== "") {
    if (!isComposerConversationId(msg.conversationId)) {
      return t("invalidConversationId");
    }
  }
  if (msg.workspaceKey !== undefined && msg.workspaceKey !== "") {
    if (!isSafePathSegment(msg.workspaceKey)) {
      return t("invalidWorkspaceKey");
    }
  }
  if (msg.projectKey !== undefined && msg.projectKey !== "") {
    if (!isSafePathSegment(msg.projectKey)) {
      return t("invalidProjectKey");
    }
  }
  return undefined;
}

export async function dispatchSidebarMessage(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  raw: unknown
): Promise<void> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const msg = raw as SidebarMessage;
  if (typeof (msg as { command?: unknown }).command !== "string") {
    return;
  }
  if (!KNOWN_COMMANDS.has(msg.command)) {
    return;
  }

  switch (msg.command) {
    case "syncNow":
    case "push":
    case "pull": {
      try {
        await vscode.commands.executeCommand(`cursorSync.${msg.command}`);
      } finally {
        emitSyncActionsIdle();
      }
      break;
    }
    case "export":
      await vscode.commands.executeCommand("cursorSync.export");
      break;
    case "import":
      await vscode.commands.executeCommand("cursorSync.import");
      break;
    case "configure": {
      if (msg.destination) {
        const { persistDestinationSettings } = await import("../remote/destination.js");
        await persistDestinationSettings(msg.destination);
      }
      await vscode.commands.executeCommand("cursorSync.configureGithub");
      break;
    }
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
      if (typeof msg.projectKey !== "string" || !isSafePathSegment(msg.projectKey)) {
        void vscode.window.showWarningMessage(t("invalidProjectKey"));
        break;
      }
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
      const idError = assertSafeChatIds(msg);
      if (idError) {
        void vscode.window.showWarningMessage(idError);
        break;
      }
      try {
        const folders = vscode.workspace.workspaceFolders;
        if (!conversationId) {
          void vscode.window.showWarningMessage(t("missingConversationIdOpen"));
        } else if (!folders || folders.length === 0) {
          void vscode.window.showWarningMessage(t("openWorkspaceFirst"));
        } else {
          try {
            const { openConversation } = await import("./chats-tab.js");
            await openConversation(context, conversationId, {
              workspaceKey: msg.workspaceKey,
              projectKey: msg.projectKey,
              backupTier: msg.backupTier,
            });
          } catch (err) {
            void vscode.window.showErrorMessage(t("couldNotOpenChat", { error: String(err) }));
          }
        }
      } finally {
        if (conversationId && isComposerConversationId(conversationId)) {
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
        void vscode.window.showWarningMessage(t("missingConversationIdFiles"));
        break;
      }
      const idError = assertSafeChatIds(msg);
      if (idError) {
        void vscode.window.showWarningMessage(idError);
        break;
      }
      try {
        const { revealConversationFiles } = await import("./chats-tab.js");
        await revealConversationFiles(msg.conversationId, msg.workspaceKey, msg.projectKey);
      } catch (err) {
        void vscode.window.showErrorMessage(t("couldNotRevealFiles", { error: String(err) }));
      }
      break;
    }
    case "chats:clearHistory":
      await clearImports(context);
      await webview.postMessage({ type: "chats:history-cleared" });
      break;
    case "history:details": {
      const { loadSyncHistory } = await import("../diagnostics.js");
      const history = await loadSyncHistory(context);
      const entry = history.find((e) => e.timestamp === msg.timestamp);
      if (!entry) {
        void vscode.window.showWarningMessage(t("historyEntryNotFound"));
        break;
      }
      const files = entry.files ?? [];
      if (files.length === 0) {
        void vscode.window.showInformationMessage(t("historyNoFileListRecorded"));
        break;
      }
      const dirLabel = entry.direction === "push" ? t("push") : t("pull");
      const countLabel =
        typeof entry.totalFileCount === "number" && entry.totalFileCount > 0
          ? t("historyFilesCountRatio", {
              changed: files.length,
              total: entry.totalFileCount,
            })
          : t("historyFiles", { n: files.length });
      const roots = resolveSyncRoots();
      const picked = await vscode.window.showQuickPick(
        files.map((syncKey) => {
          const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
          return {
            label: syncKey,
            description: absolutePath ?? syncKey,
            syncKey,
            absolutePath,
          };
        }),
        {
          title: `${dirLabel} · ${countLabel}`,
          placeHolder: t("historyFilesPlaceholder"),
          matchOnDescription: true,
        }
      );
      if (!picked) {
        break;
      }
      if (!picked.absolutePath) {
        void vscode.window.showWarningMessage(
          t("historyFileNotFound", { path: picked.syncKey })
        );
        break;
      }
      try {
        await fs.access(picked.absolutePath);
        await vscode.commands.executeCommand(
          "vscode.open",
          vscode.Uri.file(picked.absolutePath)
        );
      } catch {
        void vscode.window.showWarningMessage(
          t("historyFileNotFound", { path: picked.syncKey })
        );
      }
      break;
    }
    case "history:page": {
      const { loadSyncHistory } = await import("../diagnostics.js");
      const { renderHistorySection, clampHistoryPage } = await import("./sync-tab.js");
      const history = await loadSyncHistory(context);
      const page = clampHistoryPage(Number(msg.page) || 0, history.length);
      const html = renderHistorySection(history, page);
      await webview.postMessage({ type: "history:update", html, page });
      break;
    }
    case "settings:get": {
      const { readSettingsValues } = await import("./settings-tab.js");
      const values = readSettingsValues();
      await webview.postMessage({ type: "settings:current", values });
      break;
    }
    case "settings:set": {
      const { updateSettingValue, readSettingsValues } = await import("./settings-tab.js");
      try {
        await updateSettingValue(msg.key, msg.value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await webview.postMessage({ type: "settings:error", message });
        await webview.postMessage({ type: "settings:current", values: readSettingsValues() });
        break;
      }
      if (msg.key === "ui.language") {
        const { rebuildSidebar } = await import("./index.js");
        rebuildSidebar();
        break;
      }
      await webview.postMessage({ type: "settings:current", values: readSettingsValues() });
      if (msg.key === "chats.syncEnabled" || msg.key.startsWith("destination.")) {
        const { refreshSidebar } = await import("./index.js");
        refreshSidebar();
      }
      break;
    }
    default:
      break;
  }
}
