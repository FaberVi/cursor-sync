import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { getLogger } from "./diagnostics.js";
import { getToken } from "./auth.js";
import { restoreChatBundle, type ChatBundle } from "./chat-persistence.js";
import { presentChatImportOutcome, promptChatImportOptions } from "./chat-import-ux.js";
import { TRANSCRIPT_MANIFEST_FILE_NAME } from "./transcript-bundle.js";

export const CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json";

export async function executeImportChatFromGist(
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
      title: "Importing chat from Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-restore-debug] gist import start gistId=${gistId}`
        );
        progress.report({ message: "Fetching Gist..." });
        const bundle = await fetchAndParseGistBundle(context, gistId, progress);
        const promptResult = await promptChatImportOptions();
        if (!promptResult) {
          return;
        }
        const result = await restoreChatBundle(
          context,
          bundle,
          progress,
          promptResult.restoreOptions
        );
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-restore-debug] gist import done gistId=${gistId} conversationId=${result.conversationId} transcriptsWritten=${result.transcriptsWritten} storeWritten=${result.storeWritten} sidebarMerged=${result.sidebarMerged} warnings=${result.warnings.length}`
        );
        await presentChatImportOutcome(
          result,
          promptResult.restoreOptions,
          "gist-chat-import"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [gist-chat-import] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Gist chat import failed: ${msg}`);
      }
    }
  );
}

async function fetchAndParseGistBundle(
  context: vscode.ExtensionContext,
  gistId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ChatBundle> {
  const logger = getLogger();
  const token = await getToken(context);
  if (!token) {
    throw new Error(
      "GitHub token not configured. Use 'Cursor Sync: Configure GitHub' to set your token."
    );
  }

  const gist = await fetchGist(gistId, token);
  if (!gist) {
    throw new Error(`Could not fetch Gist "${gistId}". Check the ID and your GitHub token.`);
  }

  progress.report({ message: "Reading chat bundle..." });
  const bundleRaw = gist.files?.[CHAT_BUNDLE_GIST_FILE_NAME]?.content;
  if (!bundleRaw) {
    if (gist.files?.[TRANSCRIPT_MANIFEST_FILE_NAME]) {
      throw new Error(
        "Gist does not contain a chat bundle (chat-bundle.json). This Gist is an agent transcript export. Use Cursor Sync: Import Agent Transcripts from Private Gist."
      );
    }
    if (gist.files?.["manifest.json"]) {
      throw new Error(
        "Gist does not contain a chat bundle (chat-bundle.json). This Gist is a settings backup. Use Cursor Sync: Import from Private Gist."
      );
    }
    throw new Error(
      "Gist does not contain chat-bundle.json. Export a chat with Cursor Sync: Export Chat to Private Gist first."
    );
  }

  progress.report({ message: "Validating chat bundle..." });
  const bundle = parseChatBundle(bundleRaw);

  const tfCount = bundle.transcriptFiles?.length ?? 0;
  const storeBytes = bundle.storeSnapshot?.sizeBytes ?? 0;
  const sidebarKeys = bundle.sidebarSnapshot ? Object.keys(bundle.sidebarSnapshot).join(",") : "none";
  logger.appendLine(
    `[${new Date().toISOString()}] [chat-restore-debug] gist import validated gistId=${gistId} conversationId=${bundle.conversationId} transcriptFiles=${tfCount} storeSnapshot=${bundle.storeSnapshot ? `${storeBytes}b` : "absent"} sidebarSnapshot=${sidebarKeys}`
  );
  return bundle;
}

function parseChatBundle(raw: string): ChatBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid chat-bundle.json: not valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid chat-bundle.json: expected an object.");
  }

  const bundle = parsed as Partial<ChatBundle>;
  if (bundle.type !== "chat-persistence") {
    throw new Error(
      `Invalid chat bundle: expected type "chat-persistence", got "${String(bundle.type)}".`
    );
  }
  if (bundle.schemaVersion !== 1) {
    throw new Error(
      `Invalid or unsupported chat bundle schema version: ${String(bundle.schemaVersion)}.`
    );
  }
  if (!bundle.conversationId || typeof bundle.conversationId !== "string") {
    throw new Error("Invalid chat bundle: missing conversationId.");
  }

  return bundle as ChatBundle;
}

async function fetchGist(
  gistId: string,
  token: string | undefined
): Promise<{ files?: Record<string, { content?: string }> } | null> {
  const gistClient = token ? new GistClient(token) : new GistClient();
  const result = await gistClient.getGist(gistId);
  if (!result.ok) {
    const status = result.error?.statusCode ?? undefined;
    const category = result.error?.category;

    if (status === 404) {
      throw new Error(
        `Gist not found. If it's private, make sure your GitHub token is configured (Cursor Sync: Configure GitHub).`
      );
    }
    if (status === 401 || status === 403 || category === "AUTH_FAILED") {
      throw new Error("Authentication failed. Check your GitHub token has Gist read access.");
    }
    if (result.error?.category === "NETWORK_ERROR") {
      throw new Error(result.error?.message ?? "Network error while fetching Gist");
    }
    throw new Error(result.error?.message ?? `Failed to fetch Gist: ${status ?? 0}`);
  }
  return result.data as { files?: Record<string, { content?: string }> };
}

function extractGistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/gist\.github\.com\/[^/]+\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1]!;

  if (/^[A-Za-z0-9-]+$/.test(trimmed)) return trimmed;

  return null;
}
