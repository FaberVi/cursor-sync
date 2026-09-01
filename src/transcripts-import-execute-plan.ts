import * as vscode from "vscode";
import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import type { GistResponse } from "./types.js";
import {
  TRANSCRIPT_MANIFEST_FILE_NAME,
  computeArtifactChecksum,
  decodeTranscriptArtifact,
  gistFileNameToSyncKey,
  getConversationIdFromRelativePath,
  syncKeyToGistFileName,
  type TranscriptManifestV1,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import { humanLabel, type ProjectInfo } from "./transcripts-discovery.js";
import {
  augmentV1ImportOperations,
  collectRequiredStoreWorkspaceKeys,
  deriveStoreWorkspaceMapping,
  listChatsWorkspaceKeys,
  preflightV2ConversationImport,
  previewAndApplyImportPlan,
  promptForWorkspaceMapping,
} from "./transcripts-import-plan.js";
import type { RestoreOperation } from "./transcripts-internal-types.js";
import { resolveArtifactImportPath } from "./transcripts-import-sidebar.js";

export async function importTranscriptBundleV1(
  context: vscode.ExtensionContext,
  gistData: GistResponse,
  manifest: TranscriptManifestV1,
  projectMapping: Map<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const operations: RestoreOperation[] = [];

  for (const [gistFileName, gistFile] of Object.entries(gistData.files)) {
    if (gistFileName === TRANSCRIPT_MANIFEST_FILE_NAME) {
      continue;
    }

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) {
      continue;
    }

    const targetProject = projectMapping.get(manifestEntry.projectKey);
    if (!targetProject) {
      continue;
    }

    const relativeInProject = syncKey.slice(`transcripts/${manifestEntry.projectKey}/`.length);
    const content = Buffer.from(gistFile.content, "utf-8");
    const checksum = computeArtifactChecksum(content);
    if (checksum !== manifestEntry.checksum) {
      vscode.window.showErrorMessage(
        `Import failed: checksum mismatch for ${relativeInProject}.`
      );
      return;
    }

    operations.push({
      absolutePath: path.join(
        targetProject.fullPath,
        "agent-transcripts",
        ...relativeInProject.split("/")
      ),
      content,
      checksum,
      syncKey,
      kind: "transcript",
      conversationId: getConversationIdFromRelativePath(relativeInProject),
    });
  }

  if (operations.length === 0) {
    vscode.window.showInformationMessage("No transcript files to write after mapping.");
    return;
  }

  const fileItems: vscode.QuickPickItem[] = operations.map((operation) => ({
    label: path.basename(operation.absolutePath),
    description: operation.absolutePath,
    picked: true,
  }));

  const selectedItems = await vscode.window.showQuickPick(fileItems, {
    canPickMany: true,
    title: `Select transcript files to import (${operations.length} total)`,
    placeHolder: "Deselect files you do not want to import",
  });

  if (!selectedItems || selectedItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled: no files selected`);
    return;
  }

  const selectedPaths = new Set(selectedItems.map((item) => item.description));
  const selectedOperations = operations.filter((operation) =>
    selectedPaths.has(operation.absolutePath)
  );

  const augmented = await augmentV1ImportOperations(
    gistData,
    selectedOperations,
    projectMapping,
    logger
  );

  await previewAndApplyImportPlan(context, augmented, "Import transcript files", logger, {
    importRestoreReport: true,
  });
}

export async function importTranscriptBundleV2(
  context: vscode.ExtensionContext,
  gistData: GistResponse,
  manifest: TranscriptManifestV2,
  projectMapping: Map<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const availableConversations = Object.entries(manifest.conversations)
    .filter(([, conversation]) => projectMapping.has(conversation.projectKey))
    .sort(([a], [b]) => a.localeCompare(b));

  if (availableConversations.length === 0) {
    vscode.window.showInformationMessage("No conversations remain after project mapping.");
    return;
  }

  const conversationItems: Array<vscode.QuickPickItem & { conversationKey: string }> =
    availableConversations.map(([conversationKey, conversation]) => ({
      conversationKey,
      label: conversation.title,
      description: `${humanLabel(conversation.projectKey)} · ${conversation.conversationId}`,
      detail: [
        conversation.subtitle,
        conversation.storeArtifact ? "store snapshot included" : "store snapshot missing",
        "sidebar sidecar + state.vscdb merge when snapshot allows",
      ].join(" · "),
      picked: true,
    }));

  const selectedConversations = await vscode.window.showQuickPick(conversationItems, {
    canPickMany: true,
    title: `Select conversations to import (${conversationItems.length} available)`,
    placeHolder: "Deselect conversations you do not want to restore",
  });

  if (!selectedConversations || selectedConversations.length === 0) {
    logger.appendLine(
      `[${new Date().toISOString()}] Transcript import cancelled: no conversations selected`
    );
    return;
  }

  const selectedConversationKeys = new Set(
    selectedConversations.map((conversation) => conversation.conversationKey)
  );

  const chatsWorkspaceKeys = await listChatsWorkspaceKeys();
  const { resolved: derivedWorkspace, ambiguousSources } = deriveStoreWorkspaceMapping(
    manifest,
    selectedConversationKeys,
    projectMapping
  );
  let workspaceMapping = new Map<string, string>(derivedWorkspace);
  const requiredStoreWorkspaceKeys = collectRequiredStoreWorkspaceKeys(
    manifest,
    selectedConversationKeys
  );
  const promptWorkspaceSources = new Set<string>(ambiguousSources);
  for (const swk of requiredStoreWorkspaceKeys) {
    if (chatsWorkspaceKeys.length > 0 && !chatsWorkspaceKeys.includes(swk)) {
      promptWorkspaceSources.add(swk);
    }
  }
  if (promptWorkspaceSources.size > 0) {
    for (const swk of promptWorkspaceSources) {
      workspaceMapping.delete(swk);
    }
    const prompted = await promptForWorkspaceMapping(
      [...promptWorkspaceSources].sort(),
      chatsWorkspaceKeys,
      logger
    );
    if (prompted === null) {
      return;
    }
    for (const [k, v] of prompted) {
      workspaceMapping.set(k, v);
    }
  }

  const preflightErrors: string[] = [];
  for (const [conversationKey, conversation] of availableConversations) {
    if (!selectedConversationKeys.has(conversationKey)) continue;
    const targetProject = projectMapping.get(conversation.projectKey);
    if (!targetProject) continue;
    preflightErrors.push(
      ...(await preflightV2ConversationImport({
        gistData,
        manifest,
        conversation,
        targetProject,
        workspaceMapping,
      }))
    );
  }

  if (preflightErrors.length > 0) {
    vscode.window.showErrorMessage(preflightErrors[0]!);
    return;
  }

  const operations: RestoreOperation[] = [];
  const stagedWarnings = new Set<string>();

  for (const [conversationKey, conversation] of availableConversations) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }

    const targetProject = projectMapping.get(conversation.projectKey);
    if (!targetProject) {
      continue;
    }

    const artifactIds = [
      ...conversation.transcriptArtifacts,
      conversation.sidebarArtifact,
      ...(conversation.storeArtifact ? [conversation.storeArtifact] : []),
    ];

    for (const artifactId of artifactIds) {
      const artifactEntry = manifest.artifacts[artifactId];
      if (!artifactEntry) {
        continue;
      }

      const gistFile = gistData.files[syncKeyToGistFileName(artifactId)];
      if (!gistFile) {
        continue;
      }

      const content = decodeTranscriptArtifact(gistFile.content, artifactEntry.encoding);

      operations.push({
        absolutePath: resolveArtifactImportPath(targetProject, artifactEntry, workspaceMapping),
        content,
        checksum: artifactEntry.checksum,
        syncKey: artifactId,
        kind: artifactEntry.kind,
        conversationId: artifactEntry.conversationId,
      });
    }

    for (const warning of conversation.warnings) {
      stagedWarnings.add(`${conversation.conversationId}: ${warning}`);
    }
  }

  if (operations.length === 0) {
    vscode.window.showInformationMessage("No bundle artifacts to restore after selection.");
    return;
  }

  await previewAndApplyImportPlan(context, operations, "Import conversation bundle", logger, {
    importRestoreReport: true,
    warnings: [...stagedWarnings].sort(),
  });
}
