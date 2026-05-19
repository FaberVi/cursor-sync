import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { getToken } from "./auth.js";
import { getLogger } from "./diagnostics.js";
import { TRANSCRIPT_MANIFEST_FILE_NAME } from "./transcript-bundle.js";
import {
  CHAT_BUNDLE_GIST_FILE_NAME,
  offerReloadAfterChatImport,
  parseChatBundle,
  restoreChatBundle,
} from "./chat-persistence.js";

export async function executeImportChatFromGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const gistInput = await vscode.window.showInputBox({
    prompt: "Enter Gist URL or ID containing a chat bundle",
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
      title: "Importing chat from Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: "Fetching Gist..." });
        const token = await getToken(context);
        if (!token) {
          throw new Error(
            "GitHub token not configured. Use 'Cursor Sync: Configure GitHub' to set your token."
          );
        }

        const client = new GistClient(token);
        const gistResult = await client.getGist(gistId);
        if (!gistResult.ok) {
          throw new Error(gistResult.error.message);
        }

        const files = gistResult.data.files ?? {};
        const bundleRaw = files[CHAT_BUNDLE_GIST_FILE_NAME]?.content;
        if (!bundleRaw) {
          if (files[TRANSCRIPT_MANIFEST_FILE_NAME]?.content) {
            throw new Error(
              "This Gist contains agent transcripts, not a chat bundle. Use Cursor Sync: Import Agent Transcripts from Private Gist."
            );
          }
          throw new Error(
            `Gist does not contain ${CHAT_BUNDLE_GIST_FILE_NAME}. Export a chat with Cursor Sync: Export Chat to Private Gist first.`
          );
        }

        progress.report({ message: "Restoring chat..." });
        const bundle = parseChatBundle(bundleRaw);
        const result = await restoreChatBundle(context, bundle, progress);

        const parts: string[] = [`Chat "${result.conversationId}" imported.`];
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
        if (result.warnings.length > 0) {
          parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
        }

        vscode.window.showInformationMessage(parts.join(" | "));
        await offerReloadAfterChatImport();

        for (const w of result.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-gist-import] ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [chat-gist-import] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat import failed: ${msg}`);
      }
    }
  );
}

function extractGistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const urlMatch = trimmed.match(/gist\.github\.com\/[^/]+\/([A-Za-z0-9-]+)/i);
  if (urlMatch) {
    return urlMatch[1]!;
  }

  if (/^[A-Za-z0-9-]+$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}
