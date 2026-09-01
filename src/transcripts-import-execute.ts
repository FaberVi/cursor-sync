import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { getToken } from "./auth.js";
import { GistClient } from "./gist.js";
import { withRetry } from "./retry.js";
import type { GistResponse } from "./types.js";
import {
  TRANSCRIPT_MANIFEST_FILE_NAME,
  isTranscriptManifestV2,
  parseTranscriptBundleManifest,
  type TranscriptManifestV1,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import {
  discoverProjects,
  findProjectMatchingOpenWorkspaceFolder,
  buildFallbackProjectMapping,
} from "./transcripts-discovery.js";
import { promptForProjectMapping } from "./transcripts-import-plan.js";
import { extractGistId } from "./transcripts-export.js";
import {
  importTranscriptBundleV1,
  importTranscriptBundleV2,
} from "./transcripts-import-execute-plan.js";

export async function executeImportTranscripts(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Transcript import started`);

  const input = await vscode.window.showInputBox({
    prompt: "Enter the Gist URL or ID containing exported transcripts",
    placeHolder: "e.g., https://gist.github.com/username/abc123 or abc123",
  });

  if (!input) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled: no input`);
    return;
  }

  const gistId = extractGistId(input);
  if (!gistId) {
    vscode.window.showErrorMessage("Invalid Gist URL or ID.");
    return;
  }

  const token = await getToken(context);
  const client = new GistClient(token);

  const gistResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Fetching transcript Gist...",
      cancellable: false,
    },
    async () => withRetry(() => client.getGist(gistId))
  );

  if (!gistResult.ok) {
    vscode.window.showErrorMessage(`Import failed: ${gistResult.error.message}`);
    return;
  }

  const gistData: GistResponse = gistResult.data;
  const manifestFile = gistData.files[TRANSCRIPT_MANIFEST_FILE_NAME];
  if (!manifestFile) {
    vscode.window.showErrorMessage(
      "Import failed: transcript-manifest.json not found. This Gist may not contain exported transcripts."
    );
    return;
  }

  let manifest: TranscriptManifestV1 | TranscriptManifestV2;
  try {
    manifest = parseTranscriptBundleManifest(manifestFile.content);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Import failed: ${error instanceof Error ? error.message : "invalid transcript-manifest.json."}`
    );
    return;
  }

  const localProjects = await discoverProjects();
  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found under ~/.cursor/projects/. " +
        "Open a project in Cursor first to create a project directory."
    );
    return;
  }

  let projectMapping = await promptForProjectMapping(
    Object.keys(manifest.sourceProjects),
    Object.fromEntries(
      Object.entries(manifest.sourceProjects).map(([projectKey, info]) => [
        projectKey,
        { fileCount: info.fileCount },
      ])
    ),
    localProjects,
    logger
  );

  if (projectMapping === null) {
    return;
  }

  if (projectMapping.size === 0) {
    const cfg = vscode.workspace.getConfiguration("cursorSync");
    const allowFallback =
      cfg.get<boolean>("transcripts.importFallbackToCurrentWorkspace") ?? true;
    if (!allowFallback) {
      vscode.window.showInformationMessage("No projects mapped. Import cancelled.");
      return;
    }
    const target = findProjectMatchingOpenWorkspaceFolder(localProjects);
    if (!target) {
      vscode.window.showErrorMessage(
        "No projects mapped. Open the correct repo folder in Cursor (File > Open Folder) so a ~/.cursor/projects/ entry matches this workspace, or map projects manually when prompted."
      );
      return;
    }
    const sourceKeys = Object.keys(manifest.sourceProjects).sort();
    const confirm = await vscode.window.showWarningMessage(
      `Map all ${sourceKeys.length} source project(s) from this Gist to this workspace’s Cursor project "${target.label}"?`,
      { modal: true },
      "Map all here",
      "Cancel"
    );
    if (confirm !== "Map all here") {
      vscode.window.showInformationMessage("Import cancelled.");
      return;
    }
    projectMapping = buildFallbackProjectMapping(sourceKeys, target);
  }

  if (isTranscriptManifestV2(manifest)) {
    await importTranscriptBundleV2(context, gistData, manifest, projectMapping, logger);
    return;
  }

  await importTranscriptBundleV1(context, gistData, manifest, projectMapping, logger);
}
