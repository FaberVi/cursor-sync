import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import { pickChatsForExport } from "./chat-export-ux.js";
import { buildChatExportPayload } from "./chat-persistence.js";
import { CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
import { encryptChatGistPayload } from "./chat-gist-crypto.js";
import { requireChatEncryptionPassword, isChatGistEncryptionEnabled } from "./chat-encryption-auth.js";

export async function executeExportChatToGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist started`);

  const selection = await pickChatsForExport();
  if (!selection) {
    return;
  }

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
        const { gistPayload, warnings, primaryTitle, bundles } = await buildChatExportPayload(
          context,
          selection,
          progress
        );
        logger.appendLine(
          `[${new Date().toISOString()}] Chat gist export workspace=${selection.workspaceKey} count=${bundles.length}`
        );

        let uploadContent = gistPayload.content;
        let encrypted = false;

        if (isChatGistEncryptionEnabled()) {
          const password = await requireChatEncryptionPassword(context, "export");
          if (!password) {
            vscode.window.showWarningMessage("Chat export cancelled: encryption password required.");
            logger.appendLine(
              `[${new Date().toISOString()}] Chat export to Gist cancelled: no encryption password`
            );
            return;
          }
          const plaintextKind =
            gistPayload.fileName === CHAT_BUNDLES_GIST_FILE_NAME
              ? ("chat-bundles-collection" as const)
              : ("chat-bundle" as const);
          uploadContent = await encryptChatGistPayload(
            gistPayload.content,
            password,
            plaintextKind
          );
          encrypted = true;
        }

        const gistFiles: Record<string, { content: string }> = {
          [gistPayload.fileName]: { content: uploadContent },
        };

        const gistCreate = await withRetry(() =>
          client.createGist(gistFiles, "Cursor Sync - Chat Export")
        );

        if (!gistCreate.ok) {
          vscode.window.showErrorMessage(`Export failed: ${gistCreate.error.message}`);
          logger.appendLine(
            `[${new Date().toISOString()}] Chat export to Gist failed: ${gistCreate.error.category} - ${gistCreate.error.message}`
          );
          return;
        }

        const gistUrl = gistCreate.data.html_url;
        logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist succeeded: ${gistUrl}`);

        for (const w of warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-export-gist] ${w}`);
        }

        const linkNote = encrypted
          ? "Content is encrypted; decryption requires the chat encryption password configured in Cursor Sync."
          : "Anyone with the link can open it.";
        const successMsg =
          bundles.length === 1
            ? `Export successful! Chat "${primaryTitle}" in private Gist at ${gistUrl}. ${linkNote}`
            : `Export successful! ${bundles.length} chats in private Gist at ${gistUrl}. ${linkNote}`;

        const action = await vscode.window.showInformationMessage(successMsg, "Copy URL");

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
