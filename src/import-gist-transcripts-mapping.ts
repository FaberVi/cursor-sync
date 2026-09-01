import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "./diagnostics.js";
import { summarizeTranscriptForSidebar } from "./transcript-bundle.js";
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import {
  humanWorkspaceLabel,
  projectQuickPickLabel,
  workspaceQuickPickLabel,
} from "./chat-workspace-label.js";
import { type WorkspaceDir } from "./chat-export-ux.js";
import { resolveSyncRoots } from "./paths.js";
import { deriveComposerHeadersPayloadFromSidebarSnapshot } from "./composer-merge.js";
import { stampWorkspaceIdentifierOnPayload } from "./transcripts-import-sidebar.js";
import { querySqliteRows } from "./transcripts-sqlite.js";
import type { DiscoveredTranscript } from "./import-gist-transcripts-fetch.js";

export function buildHeadersPayloads(
  transcripts: DiscoveredTranscript[],
  projectMapping: Map<string, string>,
  logger?: ReturnType<typeof getLogger>
): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];

  for (const transcript of transcripts) {
    const summary = summarizeTranscriptForSidebar(transcript.content, transcript.conversationId);

    let payload = deriveComposerHeadersPayloadFromSidebarSnapshot({
      conversationId: transcript.conversationId,
      title: summary.title,
      subtitle: summary.subtitle,
      lastUpdatedAt: summary.lastUpdatedAt ?? new Date().toISOString(),
    });

    if (payload) {
      // Use stampWorkspaceIdentifierOnPayload which reads the real workspace folder
      // from vscode.workspace.workspaceFolders and stamps a matching workspaceIdentifier.
      // This ensures imported chats appear in the sidebar for the currently open workspace.
      const stamped = stampWorkspaceIdentifierOnPayload(payload);
      payloads.push(stamped);
    } else {
      logger?.appendLine(`[gist-import] WARNING: deriveComposerHeadersPayload returned undefined for: ${transcript.conversationId}`);
    }
  }

  return payloads;
}

export async function readExistingComposerState(
  dbPath: string,
  logger?: ReturnType<typeof getLogger>
): Promise<{ headersRaw: string | undefined; dataRaw: string | undefined }> {
  const rows = await querySqliteRows(
    dbPath,
    "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');",
    { retries: 3 }
  );

  let headersRaw: string | undefined;
  let dataRaw: string | undefined;

  for (const row of rows) {
    const key = String(row.key ?? "");
    const value = row.value;
    if (key === "composer.composerHeaders") {
      headersRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
    if (key === "composer.composerData") {
      dataRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
  }

  return { headersRaw, dataRaw };
}

export async function promptForTargetWorkspace(
  localWorkspaces: WorkspaceDir[]
): Promise<string | null> {
  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const picks: vscode.QuickPickItem[] = localWorkspaces.map((w) => {
    const row = workspaceQuickPickLabel(w.name, folderMap);
    return { label: row.label, description: row.description, detail: w.fullPath };
  });

  const selected = await vscode.window.showQuickPick(picks, {
    title: "Select target workspace for imported chats",
    placeHolder: "Choose the workspace where chat sessions will appear",
  });

  return selected?.description ?? null;
}

export function resolveProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

export async function promptForProjectMapping(
  sourceProjectKeys: string[]
): Promise<Map<string, string> | null> {
  const projectsRoot = resolveProjectsRoot();
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    vscode.window.showErrorMessage(
      `Cannot read projects directory: ${projectsRoot}. Open a project in Cursor first.`
    );
    return null;
  }

  const localProjects = projectDirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found. Open a project in Cursor first."
    );
    return null;
  }

  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const mapping = new Map<string, string>();

  for (const sourceKey of sourceProjectKeys) {
    const sourceLabel = humanWorkspaceLabel(sourceKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
      label: projectQuickPickLabel(p.name, folderMap),
      description: p.name,
      detail: path.join(projectsRoot, p.name),
    }));
    picks.unshift({ label: "(Keep original)", description: sourceKey });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" to a local project`,
      placeHolder: `Select the local project to receive transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      return null;
    }

    mapping.set(sourceKey, selected.description!);
  }

  return mapping;
}
