import * as vscode from "vscode";
import { TRANSCRIPTS_EXPORT_GIST_DESCRIPTION } from "./extension-branding.js";
import { getLogger } from "./diagnostics.js";
import { withRetry } from "./retry.js";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { discoverExportConversationCandidates, discoverProjects } from "./transcripts-discovery.js";
import { buildExportBundleV2 } from "./transcripts-export-bundle.js";

export { buildExportBundleV2 } from "./transcripts-export-bundle.js";

export async function executeExportTranscripts(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Transcript export started`);

  const config = vscode.workspace.getConfiguration("cursorSync");
  const enabled = config.get<boolean>("transcripts.enabled") ?? false;
  if (!enabled) {
    const action = await vscode.window.showWarningMessage(
      "Agent transcript sync is not enabled. Enable it now?",
      "Enable",
      "Cancel"
    );
    if (action !== "Enable") return;
    await config.update("transcripts.enabled", true, vscode.ConfigurationTarget.Global);
  }

  const token = await requireToken(context);
  if (!token) return;

  const maxFileSizeKB = config.get<number>("transcripts.maxFileSizeKB") ?? 2048;
  const maxBytes = maxFileSizeKB * 1024;

  const projects = await discoverProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No Cursor projects found under ~/.cursor/projects/.");
    return;
  }

  const projectPicks: vscode.QuickPickItem[] = projects.map((p) => ({
    label: p.label,
    description: p.folderName,
    picked: false,
  }));

  const selectedProjectItems = await vscode.window.showQuickPick(projectPicks, {
    canPickMany: true,
    title: "Select source projects to export transcripts from",
    placeHolder: "Choose one or more projects",
  });

  if (!selectedProjectItems || selectedProjectItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript export cancelled: no projects selected`);
    return;
  }

  const selectedProjects = projects.filter((p) =>
    selectedProjectItems.some((item) => item.description === p.folderName)
  );

  const candidates = await discoverExportConversationCandidates(selectedProjects, maxBytes);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      "No conversations found. Expected ~/.cursor/projects/<project>/agent-transcripts/<conversation-id>/ with jsonl files and/or a matching ~/.cursor/chats/*/store.db."
    );
    return;
  }

  const convPicks: Array<vscode.QuickPickItem & { conversationKey: string }> = candidates.map((c) => ({
    conversationKey: `${c.projectKey}:${c.conversationId}`,
    label: c.label,
    description: c.description,
    detail: c.detail,
    picked: true,
  }));

  const selectedConvItems = await vscode.window.showQuickPick(convPicks, {
    canPickMany: true,
    title: `Select conversations to export (${candidates.length} found)`,
    placeHolder: "Each selection includes all jsonl under that conversation, plus store.db and sidebar metadata when available",
  });

  if (!selectedConvItems || selectedConvItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript export cancelled: no conversations selected`);
    return;
  }

  const selectedKeys = new Set<string>();
  for (const item of selectedConvItems) {
    const ck = (item as { conversationKey?: string }).conversationKey;
    if (ck) {
      selectedKeys.add(ck);
    }
  }
  const selectedPlans = candidates.filter((c) => selectedKeys.has(`${c.projectKey}:${c.conversationId}`));

  const artifactCount = selectedPlans.reduce(
    (n, p) => n + p.transcriptFiles.length + 1 + (p.hasStore ? 1 : 0),
    0
  );

  const confirm = await vscode.window.showWarningMessage(
    `This will create a private Gist with ${selectedPlans.length} conversation(s) (${artifactCount} artifact(s) including sidecars). ` +
      "It is not listed on your public profile, but anyone with the direct URL can still open it. " +
      "Transcripts may contain sensitive data (prompts, code, secrets). Continue?",
    { modal: true },
    "Export"
  );
  if (confirm !== "Export") return;

  const { gistFiles } = await buildExportBundleV2(selectedPlans, selectedProjects);

  const client = new GistClient(token);

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating private Gist with transcripts...",
      cancellable: false,
    },
    async () => {
      const result = await withRetry(() =>
        client.createGist(gistFiles, TRANSCRIPTS_EXPORT_GIST_DESCRIPTION)
      );

      if (!result.ok) {
        vscode.window.showErrorMessage(`Transcript export failed: ${result.error.message}`);
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript export failed: ${result.error.category} - ${result.error.message}`
        );
        return;
      }

      const gistUrl = result.data.html_url;
      logger.appendLine(`[${new Date().toISOString()}] Transcript export succeeded: ${gistUrl}`);

      const action = await vscode.window.showInformationMessage(
        `Transcript export successful! Private Gist: ${gistUrl}. Anyone with the link can open it.`,
        "Copy URL"
      );
      if (action === "Copy URL") {
        await vscode.env.clipboard.writeText(gistUrl);
      }
    }
  );
}

export function extractGistId(input: string): string | null {
  const match = input.match(
    /(?:gist\.github\.com\/[^/]+\/|)([a-f0-9]{32}|[a-f0-9]{20})/i
  );
  return match ? match[1] : null;
}
