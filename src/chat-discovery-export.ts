import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  loadComposerNameIndexForChatsWorkspaceKey,
  loadGlobalComposerNameIndex,
  resolveComposerConversationTitle,
} from "./composer-title.js";
import { discoverProjects, enumerateTranscriptFilesInConversation } from "./transcripts-discovery.js";
import { summarizeDiscoveredBackupTier, type LocalDiskKvProbe } from "./chat-backup-eligibility.js";
import {
  TRANSCRIPT_SCAN_MAX_BYTES,
  resolveProjectsRoot,
  type ConversationExportRow,
  type DiscoveredConversation,
} from "./chat-discovery.js";

export async function discoveredToExportRows(
  discovered: DiscoveredConversation[],
  options: {
    workspaceIndex?: Map<string, string>;
    globalIndex?: Map<string, string>;
    projectsRoot?: string;
    projectKey?: string;
    diskKvProbes?: Map<string, LocalDiskKvProbe>;
    probeDiskKv?: boolean;
  } = {}
): Promise<ConversationExportRow[]> {
  const projectsRoot = options.projectsRoot ?? resolveProjectsRoot();
  const globalIndex = options.globalIndex ?? (await loadGlobalComposerNameIndex());
  const projects = await discoverProjects(projectsRoot);
  const orderedProjectsForKey = options.projectKey
    ? projects.filter((p) => p.folderName === options.projectKey)
    : projects;
  const workspaceIndexCache = new Map<string, Map<string, string>>();
  const rows: ConversationExportRow[] = [];
  for (const item of discovered) {
    const workspaceIndex =
      options.workspaceIndex ??
      (item.workspaceKey
        ? await (async () => {
            const cached = workspaceIndexCache.get(item.workspaceKey);
            if (cached) {
              return cached;
            }
            const loaded = await loadComposerNameIndexForChatsWorkspaceKey(item.workspaceKey);
            workspaceIndexCache.set(item.workspaceKey, loaded);
            return loaded;
          })()
        : new Map<string, string>());
    let transcriptContent: string | null = null;
    const projectKey = item.projectKey ?? options.projectKey;
    if (item.jsonlCount > 0) {
      const orderedProjects = projectKey
        ? orderedProjectsForKey
        : projects;
      for (const proj of orderedProjects) {
        const convDir = path.join(
          proj.fullPath,
          "agent-transcripts",
          item.conversationId
        );
        try {
          const files = await enumerateTranscriptFilesInConversation(
            proj.fullPath,
            item.conversationId,
            TRANSCRIPT_SCAN_MAX_BYTES
          );
          const preferred =
            files.find(
              (f) => path.basename(f.absolutePath, ".jsonl") === item.conversationId
            ) ?? files[0];
          if (!preferred) {
            continue;
          }
          transcriptContent = (
            await fs.readFile(preferred.absolutePath, "utf-8")
          ).toString();
          break;
        } catch {
          try {
            const dirFiles = await fs.readdir(convDir);
            const jsonl = dirFiles.find((f) => f.endsWith(".jsonl"));
            if (!jsonl) {
              continue;
            }
            transcriptContent = (
              await fs.readFile(path.join(convDir, jsonl), "utf-8")
            ).toString();
            break;
          } catch {
            continue;
          }
        }
      }
    }
    const title = await resolveComposerConversationTitle({
      conversationId: item.conversationId,
      chatsWorkspaceKey: item.workspaceKey || undefined,
      transcriptContent,
      workspaceIndex,
      globalIndex,
    });
    let diskKv =
      options.diskKvProbes?.get(item.conversationId) ?? null;
    if (options.probeDiskKv && !diskKv) {
      const { probeLocalDiskKv } = await import("./chat-disk-kv-export.js");
      diskKv = await probeLocalDiskKv(item.conversationId);
    }
    const tierSummary = summarizeDiscoveredBackupTier(item, diskKv);
    rows.push({
      conversationId: item.conversationId,
      label: title,
      description: item.conversationId,
      detail: tierSummary.detail,
      workspaceKey: item.workspaceKey || undefined,
      projectKey: item.projectKey || options.projectKey,
      hasStore: item.hasStore,
      jsonlCount: item.jsonlCount,
      subagentJsonlCount: item.subagentJsonlCount,
      backupTier: tierSummary.tier,
      backupTierLabel: tierSummary.label,
      fidelityWarnings:
        tierSummary.warnings.length > 0 ? tierSummary.warnings : undefined,
    });
  }
  return rows;
}
