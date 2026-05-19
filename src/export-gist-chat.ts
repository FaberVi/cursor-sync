import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import {
  buildChatBundle,
  CHAT_BUNDLE_GIST_FILE_NAME,
} from "./chat-persistence.js";

const GIST_DESCRIPTION = "Cursor Sync - Chat Export";

export async function executeExportChatToGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const token = await requireToken(context);
  if (!token) {
    return;
  }

  const conversationId = await vscode.window.showInputBox({
    prompt: "Enter the conversation ID to export to a private Gist",
    placeHolder: "e.g. abc123-def456-...",
    ignoreFocusOut: true,
  });

  if (!conversationId || conversationId.trim().length === 0) {
    return;
  }

  const trimmedId = conversationId.trim();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Exporting chat to private Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const { bundle, title, warnings } = await buildChatBundle(trimmedId, progress);

        const gistFiles: Record<string, { content: string }> = {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: JSON.stringify(bundle, null, 2) },
        };

        const client = new GistClient(token);
        const result = await withRetry(() =>
          client.createGist(gistFiles, GIST_DESCRIPTION)
        );

        if (!result.ok) {
          vscode.window.showErrorMessage(`Chat export failed: ${result.error.message}`);
          logger.appendLine(
            `[${new Date().toISOString()}] [chat-gist-export] FAILED: ${result.error.message}`
          );
          return;
        }

        const gistUrl = result.data.html_url;
        let msg = `Chat "${title}" exported to private Gist: ${gistUrl}. Anyone with the link can open it.`;
        if (warnings.length > 0) {
          msg += ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`;
        }

        const action = await vscode.window.showInformationMessage(msg, "Copy URL");
        if (action === "Copy URL") {
          await vscode.env.clipboard.writeText(gistUrl);
          vscode.window.showInformationMessage("Gist URL copied to clipboard.");
        }

        for (const w of warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-gist-export] ${w}`);
        }
        logger.appendLine(`[${new Date().toISOString()}] [chat-gist-export] ${gistUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [chat-gist-export] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat export failed: ${msg}`);
      }
    }
  );
}
