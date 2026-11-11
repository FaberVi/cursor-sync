import * as vscode from "vscode";
import type { BundleDiscoveryEntry } from "./bundle-discovery.js";
import { listLocalBundles } from "./bundle-discovery.js";
import { listImports } from "./import-history.js";
import type { ChatImportHistoryEntry } from "./import-history.js";
import { t } from "./i18n.js";
import {
  discoverConversationsGroupedByProject,
  discoverConversationsForProject,
  discoveredToExportRows,
  resolveProjectsRoot,
  type ConversationExportRow,
} from "../chat-discovery.js";
import { discoverProjects } from "../transcripts-discovery.js";
import { buildChatsKeyToFolderMap } from "../chat-workspace-context.js";
import { resolveSyncRoots } from "../paths.js";
import { resolveChatsRoot } from "../transcripts-cursor-paths.js";
import {
  clearGroupedDiscoveryCache,
  getGroupedDiscoveryCache,
  setGroupedDiscoveryCache,
} from "./chats-group-cache.js";
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
  let group = getGroupedDiscoveryCache()?.find((g) => g.projectKey === projectKey);
  if (!group) {
    const projectsRoot = resolveProjectsRoot();
    const project = (await discoverProjects(projectsRoot)).find(
      (p) => p.folderName === projectKey
    );
    if (!project) {
      return [];
    }
    const { cursorUser } = resolveSyncRoots();
    const folderMap = await buildChatsKeyToFolderMap(cursorUser);
    const discovered = await discoverConversationsForProject(project, {
      projectsRoot,
      chatsRoot: resolveChatsRoot(),
      folderMap,
    });
    if (!discovered) {
      return [];
    }
    group = discovered;
    const cache = getGroupedDiscoveryCache() ?? [];
    const next = cache.filter((g) => g.projectKey !== projectKey);
    next.push(discovered);
    setGroupedDiscoveryCache(next);
  }
  return discoveredToExportRows(group.conversations, {
    projectKey: group.projectKey,
    probeDiskKv: false,
  });
}

export async function listLocalConversationsGrouped(): Promise<ChatsGroupedResult> {
  try {
    const groups = await discoverConversationsGroupedByProject();
    setGroupedDiscoveryCache(groups);
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
    clearGroupedDiscoveryCache();
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

async function resolveWorkspaceUriForOpenChat(options: {
  workspaceKey?: string;
  projectKey?: string;
}): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const { buildChatsKeyToFolderMap, pathsReferToSameFolder } = await import(
    "../chat-workspace-context.js"
  );
  const { resolveSyncRoots } = await import("../paths.js");
  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);

  const pickOpenUri = (mappedPath: string): vscode.Uri => {
    const openMatch = folders.find((f) => pathsReferToSameFolder(f.uri.fsPath, mappedPath));
    return openMatch?.uri ?? vscode.Uri.file(mappedPath);
  };

  const workspaceKey = options.workspaceKey?.trim();
  if (workspaceKey) {
    const mapped = folderMap.get(workspaceKey);
    if (!mapped) {
      return undefined;
    }
    return pickOpenUri(mapped);
  }

  const projectKey = options.projectKey?.trim();
  if (projectKey) {
    if (folderMap.has(projectKey)) {
      return pickOpenUri(folderMap.get(projectKey)!);
    }
    const { folderToProjectKey } = await import("../chat-workspace-context.js");
    for (const [chatsKey, mappedPath] of folderMap) {
      if (folderToProjectKey(mappedPath) === projectKey || chatsKey === projectKey) {
        return pickOpenUri(mappedPath);
      }
    }
    return undefined;
  }

  return folders[0]?.uri;
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

  const hasIdentityHint = Boolean(options.workspaceKey?.trim() || options.projectKey?.trim());
  const folderUri = await resolveWorkspaceUriForOpenChat(options);
  if (!folderUri) {
    void vscode.window.showWarningMessage(
      hasIdentityHint ? t("couldNotResolveChatFolder") : t("openWorkspaceFirst")
    );
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
    const outcome = await activateExistingChat(context, conversationId, folderUri);
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
