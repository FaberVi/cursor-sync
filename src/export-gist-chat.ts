import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import { buildChatBundle } from "./chat-persistence.js";

export const CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json";

export async function executeExportChatToGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist started`);

  const conversationId = await vscode.window.showInputBox({
    prompt: "Enter the conversation ID (folder name under agent-transcripts or chats)",
    placeHolder: "e.g. abc123-def456-...",
    ignoreFocusOut: true,
  });

  if (!conversationId || conversationId.trim().length === 0) {
    return;
  }

  const trimmedId = conversationId.trim();

  const token = await requireToken(context);
  if (!token) {
    logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist failed: AUTH_FAILED`);
    return;
  }

  const client = new GistClient(token);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating private Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const { bundle, title, warnings } = await buildChatBundle(context, trimmedId, progress);
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-restore-debug] gist export bundle conversationId=${bundle.conversationId} title=${title} transcriptFiles=${bundle.transcriptFiles.length} storeSnapshot=${bundle.storeSnapshot ? `${bundle.storeSnapshot.sizeBytes}b` : "absent"} sidebarSnapshot=${bundle.sidebarSnapshot ? Object.keys(bundle.sidebarSnapshot).join(",") : "absent"} warnings=${warnings.length}`
        );

        const gistFiles: Record<string, { content: string }> = {
          [CHAT_BUNDLE_GIST_FILE_NAME]: {
            content: JSON.stringify(bundle, null, 2),
          },
        };

        const result = await withRetry(() =>
          client.createGist(gistFiles, "Cursor Sync - Chat Export")
        );

        if (!result.ok) {
          vscode.window.showErrorMessage(`Export failed: ${result.error.message}`);
          logger.appendLine(
            `[${new Date().toISOString()}] Chat export to Gist failed: ${result.error.category} - ${result.error.message}`
          );
          return;
        }

        const gistUrl = result.data.html_url;
        logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist succeeded: ${gistUrl}`);

        for (const w of warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-export-gist] ${w}`);
        }

        const action = await vscode.window.showInformationMessage(
          `Export successful! Chat "${title}" in private Gist at ${gistUrl}. Anyone with the link can open it.`,
          "Copy URL"
        );

        if (action === "Copy URL") {
          await vscode.env.clipboard.writeText(gistUrl);
          vscode.window.showInformationMessage("Gist URL copied to clipboard.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat export failed: ${msg}`);
      }
    }
  );
}
