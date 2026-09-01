import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import { getToken } from "./auth.js";
import { createBackup, rollbackFromBackup, pruneOldBackups } from "./rollback.js";
import {
  TRANSCRIPT_MANIFEST_FILE_NAME,
  parseTranscriptBundleManifest,
  type TranscriptBundleManifest,
} from "./transcript-bundle.js";
import { listChatsWorkspaceDirs } from "./chat-export-ux.js";
import {
  escapeSqlLiteral,
  mergeComposerHeadersChain,
} from "./composer-merge.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import {
  isExecFileTimeoutError,
  resolveStateDbCandidates,
  runSqliteScript,
} from "./transcripts-sqlite.js";
import {
  assertPathUnderRoot,
  isComposerConversationId,
  isSafePathSegment,
} from "./composer-id.js";
import {
  discoverTranscripts,
  extractGistId,
  fetchGist,
} from "./import-gist-transcripts-fetch.js";
import {
  buildHeadersPayloads,
  promptForProjectMapping,
  promptForTargetWorkspace,
  readExistingComposerState,
  resolveProjectsRoot,
} from "./import-gist-transcripts-mapping.js";

interface ImportFromGistResult {
  transcriptsWritten: number;
  sidebarMerged: boolean;
  conversationIds: string[];
  warnings: string[];
}

/**
 * Main entry point: imports agent transcripts from any GitHub Gist URL or ID.
 */
export async function executeImportTranscriptsFromGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const gistInput = await vscode.window.showInputBox({
    prompt: "Enter Gist URL or ID",
    placeHolder: "https://gist.github.com/user/abc123 or just abc123",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const id = extractGistId(value);
      return id ? null : "Invalid Gist URL or ID";
    },
  });

  if (!gistInput) {
    return;
  }

  const gistId = extractGistId(gistInput);
  if (!gistId) {
    vscode.window.showErrorMessage("Could not extract a valid Gist ID from input.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Importing transcripts from Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await importTranscriptsFromGist(context, gistId, progress);

        const parts: string[] = [
          `Imported ${result.transcriptsWritten} chat session${result.transcriptsWritten === 1 ? "" : "s"}.`,
        ];
        if (result.warnings.length > 0) {
          parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
        }

        vscode.window.showInformationMessage(parts.join(" | "));

        if (result.sidebarMerged) {
          const config = vscode.workspace.getConfiguration("cursorSync");
          const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
          if (autoReload) {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          } else {
            const reloadAction = "Reload Window";
            const choice = await vscode.window.showInformationMessage(
              "Chat sessions have been merged into the sidebar. Reload to see them.",
              reloadAction
            );
            if (choice === reloadAction) {
              vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          }
        }

        for (const w of result.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [gist-import] ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [gist-import] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Gist import failed: ${msg}`);
      }
    }
  );
}

async function importTranscriptsFromGist(
  context: vscode.ExtensionContext,
  gistId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ImportFromGistResult> {
  const warnings: string[] = [];

  // Step 1: Fetch Gist
  progress.report({ message: "Fetching Gist..." });
  const token = await getToken(context);
  if (!token) {
    throw new Error("GitHub token not configured. Use 'Cursor Sync: Configure GitHub' to set your token.");
  }
  const gist = await fetchGist(gistId, token);
  if (!gist) {
    throw new Error(`Could not fetch Gist "${gistId}". Check the ID and your GitHub token.`);
  }

  // Step 2: Parse manifest
  progress.report({ message: "Parsing manifest..." });
  const manifestRaw = gist.files?.[TRANSCRIPT_MANIFEST_FILE_NAME]?.content;
  if (!manifestRaw) {
    throw new Error("Gist does not contain a transcript manifest. Export transcripts first.");
  }

  let manifest: TranscriptBundleManifest;
  try {
    manifest = parseTranscriptBundleManifest(manifestRaw);
  } catch (err) {
    throw new Error(`Invalid manifest: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: Discover transcripts
  progress.report({ message: "Discovering transcripts..." });
  const transcripts = discoverTranscripts(manifest, gist);
  if (transcripts.length === 0) {
    throw new Error("No transcript files found in Gist.");
  }

  // Step 4: Select target workspace
  progress.report({ message: "Selecting target workspace..." });
  const chatsRoot = resolveChatsRoot();
  const localWorkspaces = await listChatsWorkspaceDirs(chatsRoot);

  let targetWorkspaceKey: string;
  if (localWorkspaces.length === 0) {
    throw new Error(
      "No local chat workspaces found in ~/.cursor/chats/. Open a workspace in Cursor first."
    );
  } else if (localWorkspaces.length === 1) {
    targetWorkspaceKey = localWorkspaces[0]!.name;
  } else {
    const picked = await promptForTargetWorkspace(localWorkspaces);
    if (!picked) {
      return { transcriptsWritten: 0, sidebarMerged: false, conversationIds: [], warnings: ["Cancelled by user."] };
    }
    targetWorkspaceKey = picked;
  }

  // Step 5: Map source projects to target projects
  progress.report({ message: "Mapping projects..." });
  const sourceProjectKeys = [...new Set(transcripts.map((t) => t.projectKey))].sort();
  const projectMapping = await promptForProjectMapping(sourceProjectKeys);
  if (projectMapping === null) {
    return { transcriptsWritten: 0, sidebarMerged: false, conversationIds: [], warnings: ["Cancelled by user."] };
  }

  // Step 6: Write transcript files
  progress.report({ message: "Writing transcript files..." });
  const writtenConversationIds: string[] = [];
  const projectsRoot = resolveProjectsRoot();

  for (const transcript of transcripts) {
    if (
      !isComposerConversationId(transcript.conversationId) ||
      !isSafePathSegment(transcript.projectKey)
    ) {
      warnings.push(
        `Skipped unsafe transcript id/path: ${transcript.projectKey}/${transcript.conversationId}`
      );
      continue;
    }
    const mappedProjectKey = projectMapping.get(transcript.projectKey) ?? transcript.projectKey;
    if (!isSafePathSegment(mappedProjectKey)) {
      warnings.push(`Skipped unsafe mapped project key: ${mappedProjectKey}`);
      continue;
    }
    const targetPathRaw = path.join(
      projectsRoot,
      mappedProjectKey,
      "agent-transcripts",
      transcript.conversationId,
      `${transcript.conversationId}.jsonl`
    );
    const targetPath = assertPathUnderRoot(targetPathRaw, projectsRoot);
    if (!targetPath) {
      warnings.push(
        `Skipped path escape for ${transcript.projectKey}/${transcript.conversationId}`
      );
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const { entries: backupEntries } = await createBackup(context, [targetPath]);
    try {
      await fs.writeFile(targetPath, transcript.content, "utf-8");
      writtenConversationIds.push(transcript.conversationId);
    } catch (err) {
      await rollbackFromBackup(backupEntries);
      warnings.push(
        `Failed to write ${transcript.conversationId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Step 7: Build sidebar payloads and merge into state.vscdb
  progress.report({ message: "Merging sidebar state..." });
  const logger = getLogger();

  const stateDbPaths = await resolveStateDbCandidates();

  let sidebarMerged = false;
  if (stateDbPaths.length === 0) {
    warnings.push("state.vscdb not found; sidebar merge skipped.");
  } else {
    const dbPath = stateDbPaths[0]!;

    try {
      const headersPayloads = buildHeadersPayloads(transcripts, projectMapping, logger);

      if (headersPayloads.length > 0) {
        const rows = await readExistingComposerState(dbPath, logger);
        const existingHeadersRaw = rows.headersRaw;

        const scriptParts: string[] = ["BEGIN IMMEDIATE;"];

        const merged = mergeComposerHeadersChain(existingHeadersRaw, headersPayloads);

        const escaped = escapeSqlLiteral(JSON.stringify(merged));
        scriptParts.push(
          `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerHeaders';`,
          `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');`
        );

        scriptParts.push("COMMIT;");

        const { entries: backupEntries } = await createBackup(context, [dbPath]);
        try {
          await runSqliteScript(dbPath, scriptParts.join("\n") + "\n");
          sidebarMerged = true;
          logger.appendLine(`[${new Date().toISOString()}] [gist-import] Sidebar merged successfully for ${headersPayloads.length} chat(s).`);
        } catch (err) {
          await rollbackFromBackup(backupEntries);
          const errMsg = err instanceof Error ? err.message : String(err);
          warnings.push(
            `state.vscdb write failed: ${errMsg}; rolled back.`
          );
        }
      } else {
        warnings.push("No sidebar payloads generated; merge skipped.");
      }
    } catch (err) {
      const isTimeout = isExecFileTimeoutError(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      warnings.push(
        isTimeout
          ? "state.vscdb timed out (database may be locked); sidebar merge skipped."
          : `state.vscdb read failed: ${errMsg}`
      );
    }
  }

  await pruneOldBackups(context);

  return {
    transcriptsWritten: writtenConversationIds.length,
    sidebarMerged,
    conversationIds: writtenConversationIds,
    warnings,
  };
}

export const __importGistTranscriptsTestUtils = {
  promptForTargetWorkspace,
  promptForProjectMapping,
};
