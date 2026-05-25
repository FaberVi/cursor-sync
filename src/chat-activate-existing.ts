import * as vscode from "vscode";
import { requireWorkspaceContext } from "./chat-workspace-context.js";
import { runPostImportActivation } from "./chat-import-activate.js";
import type { ChatBundle } from "./chat-persistence.js";

export async function activateExistingChat(
  context: vscode.ExtensionContext,
  conversationId: string,
  workspaceFolder: vscode.Uri
): Promise<{ ok: boolean; composerId?: string; stagedOnly: boolean }> {
  const wsCtx = await requireWorkspaceContext({ workspaceFolder: workspaceFolder.fsPath });

  const minimalBundle = {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt: new Date().toISOString(),
    conversationId,
    title: conversationId,
    subtitle: "",
    previewText: "",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [],
  } as unknown as ChatBundle;

  const outcome = await runPostImportActivation(
    minimalBundle,
    conversationId,
    wsCtx,
    {
      activateStrict: false,
      bridgeWaitResultMs: 0,
      dryRun: false,
      extensionPath: context.extensionUri.fsPath,
      skipPythonBridge: true,
    }
  );

  return {
    ok: outcome.ok,
    composerId: outcome.composerId,
    stagedOnly: outcome.stagedOnly,
  };
}
