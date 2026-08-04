import * as vscode from "vscode";
import type { BundleDiscoveryEntry } from "./bundle-discovery.js";
import { listLocalBundles } from "./bundle-discovery.js";
import { listImports } from "./import-history.js";
import type { ChatImportHistoryEntry } from "./import-history.js";
import { t } from "./i18n.js";
import {
  discoverConversationsGroupedByProject,
  discoveredToExportRows,
  type ConversationExportRow,
} from "../chat-discovery.js";
import {
  openTranscriptForConversation,
  revealConversationFiles,
} from "./chats-tab-locations.js";
export {
  publishImportFidelitySummary,
  fidelityFieldsForImportHistory,
} from "./chats-tab-fidelity.js";
export {
  resolveConversationFileTargets,
  openTranscriptForConversation,
  revealConversationFiles,
  type ConversationFileTargets,
} from "./chats-tab-locations.js";

export interface ChatsProjectGroup {
  projectKey: string;
  label: string;
  pathHint?: string;
  isCurrentWorkspace: boolean;
  conversationCount: number;
  rows: ConversationExportRow[];
}

export interface ChatsGroupedResult {
  groups: ChatsProjectGroup[];
  totalConversations: number;
}

export interface ChatsImportsResult {
  rows: ChatImportHistoryEntry[];
}

export interface ChatsBundlesResult {
  entries: BundleDiscoveryEntry[];
}

export async function loadConversationGroupRows(
  projectKey: string
): Promise<ConversationExportRow[]> {
  const groups = await discoverConversationsGroupedByProject();
  const group = groups.find((g) => g.projectKey === projectKey);
  if (!group) {
    return [];
  }
  return discoveredToExportRows(group.conversations, {
    projectKey: group.projectKey,
    probeDiskKv: true,
  });
}

export async function listLocalConversationsGrouped(): Promise<ChatsGroupedResult> {
  try {
    const groups = await discoverConversationsGroupedByProject();
    const built: ChatsProjectGroup[] = [];
    let totalConversations = 0;
    for (const group of groups) {
      built.push({
        projectKey: group.projectKey,
        label: group.label,
        pathHint: group.pathHint,
        isCurrentWorkspace: group.isCurrentWorkspace,
        conversationCount: group.conversations.length,
        rows: [],
      });
      totalConversations += group.conversations.length;
    }
    return { groups: built, totalConversations };
  } catch {
    return { groups: [], totalConversations: 0 };
  }
}

export function listImportHistory(
  context: vscode.ExtensionContext
): ChatsImportsResult {
  return { rows: listImports(context) };
}

export async function listBundles(
  context: vscode.ExtensionContext
): Promise<ChatsBundlesResult> {
  const entries = await listLocalBundles(context);
  return { entries };
}

async function tryQuickOpenComposer(conversationId: string): Promise<boolean> {
  const { openExistingComposerInNewTab } = await import("../chat-import-activate.js");
  const logger = (await import("../diagnostics.js")).getLogger();
  return openExistingComposerInNewTab(conversationId, {
    log: (message) => logger.appendLine(message),
  });
}

export async function openConversation(
  context: vscode.ExtensionContext,
  conversationId: string,
  options: {
    workspaceKey?: string;
    projectKey?: string;
    backupTier?: string;
  } = {}
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage(t("openWorkspaceFirst"));
    return;
  }
  const folder = folders[0];
  if (!folder) {
    return;
  }

  const tier = options.backupTier as
    | import("../chat-backup-eligibility.js").BackupTier
    | undefined;
  const {
    shouldWarnBeforeOpeningChat,
    openChatTierWarningMessage,
  } = await import("../chat-backup-eligibility.js");
  if (shouldWarnBeforeOpeningChat(tier)) {
    const openAnyway = t("openAnyway");
    const proceed = await vscode.window.showWarningMessage(
      openChatTierWarningMessage(tier!),
      openAnyway,
      t("cancel")
    );
    if (proceed !== openAnyway) {
      return;
    }
  }

  try {
    const { activateExistingChat } = await import("../chat-activate-existing.js");
    const outcome = await activateExistingChat(context, conversationId, folder.uri);
    if (outcome.ok) {
      return;
    }
  } catch (err) {
    const logger = (await import("../diagnostics.js")).getLogger();
    logger.appendLine(`activateExistingChat failed: ${String(err)}`);
  }

  if (await tryQuickOpenComposer(conversationId)) {
    return;
  }

  const opened = await openTranscriptForConversation(
    conversationId,
    options.workspaceKey,
    options.projectKey
  );
  if (opened) {
    void vscode.window.showInformationMessage(t("openedTranscriptReload"));
    return;
  }

  void vscode.window.showWarningMessage(
    t("couldNotOpenChatDisk", { id: conversationId })
  );
}

/** @deprecated Use revealConversationFiles */
export async function revealTranscriptsForConversation(
  conversationId: string
): Promise<void> {
  await revealConversationFiles(conversationId);
}
