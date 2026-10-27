import type { ChatBundle, LoadChatResult, RestoreChatBundleOptions } from "./chat-persistence.js";
import type * as vscode from "vscode";

/**
 * Pull never prompts "Activate now?". In-process Composer activation runs during
 * restore when the destination folder is open and `chatImport.activateDefault` is true.
 */
export async function maybeActivateChatsAfterPull(
  _context: vscode.ExtensionContext,
  _importedBundles: ChatBundle[],
  _successes: LoadChatResult[],
  _restoreOptions: RestoreChatBundleOptions
): Promise<void> {
  return;
}
