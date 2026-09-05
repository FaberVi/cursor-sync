import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import type { GistResponse } from "./types.js";
import {
  bundleArtifactSyncKey,
  computeArtifactChecksum,
  decodeTranscriptArtifact,
  syncKeyToGistFileName,
  type TranscriptBundleConversationEntry,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import type {
  ExportConversationState,
  RestoreOperation,
} from "./transcripts-internal-types.js";
import type { ProjectInfo } from "./transcripts-discovery.js";
import { buildSidebarMetadataSnapshot } from "./transcripts-import-sidebar.js";
import {
  isSafeWorkspaceKeySegment,
  listChatsWorkspaceKeys,
} from "./transcripts-import-mapping.js";

export {
  collectRequiredStoreWorkspaceKeys,
  deriveStoreWorkspaceMapping,
  isSafeWorkspaceKeySegment,
  listChatsWorkspaceKeys,
  promptForProjectMapping,
  promptForWorkspaceMapping,
} from "./transcripts-import-mapping.js";
export {
  applyRestoreOperations,
  previewAndApplyImportPlan,
  previewRestoreOperations,
} from "./transcripts-import-apply.js";

function getSourceProjectKeyFromTranscriptSyncKey(syncKey: string): string | undefined {
  const prefix = "transcripts/";
  if (!syncKey.startsWith(prefix)) {
    return undefined;
  }
  const rest = syncKey.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return slash === -1 && rest.length > 0 ? rest : undefined;
  }
  return rest.slice(0, slash);
}

function decodeTolerantStoreGistContent(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Buffer.alloc(0);
  }
  const noWs = trimmed.replace(/\s/g, "");
  try {
    const asB64 = Buffer.from(noWs, "base64");
    if (asB64.length >= 16 && asB64.subarray(0, 15).toString("latin1") === "SQLite format 3") {
      return asB64;
    }
    if (noWs.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(noWs) && noWs.length % 4 === 0) {
      return asB64;
    }
  } catch {
  }
  return decodeTranscriptArtifact(trimmed, undefined);
}

async function resolveV1ImportStoreChatsWorkspaceKey(defaultKey: string): Promise<string> {
  const keys = await listChatsWorkspaceKeys();
  if (keys.length === 0) {
    return defaultKey;
  }
  if (keys.length === 1) {
    return keys[0]!;
  }
  const picks: vscode.QuickPickItem[] = keys.map((k) => ({ label: k, description: k }));
  picks.unshift({ label: `Use default (${defaultKey})`, description: defaultKey });
  picks.push({ label: "Enter custom workspace key…", description: "__custom__" });
  const selected = await vscode.window.showQuickPick(picks, {
    title: "Legacy bundle: restore store.db under which ~/.cursor/chats key?",
    placeHolder: "Chats workspace hash is not the Cursor project folder name",
  });
  if (!selected?.description) {
    return defaultKey;
  }
  if (selected.description === "__custom__") {
    const raw = await vscode.window.showInputBox({
      prompt: "Target directory name under ~/.cursor/chats/",
      validateInput: (v) => {
        if (!v || !isSafeWorkspaceKeySegment(v.trim())) {
          return "Use one non-empty path segment without slashes.";
        }
        return undefined;
      },
    });
    if (raw === undefined) {
      return defaultKey;
    }
    return raw.trim();
  }
  return selected.description;
}

export async function augmentV1ImportOperations(
  gistData: GistResponse,
  transcriptOperations: RestoreOperation[],
  projectMapping: ReadonlyMap<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<RestoreOperation[]> {
  const extra: RestoreOperation[] = [];
  const seenStores = new Set<string>();
  const seenSidebars = new Set<string>();

  const groups = new Map<
    string,
    {
      sourceProjectKey: string;
      conversationId: string;
      targetProject: ProjectInfo;
      ops: RestoreOperation[];
    }
  >();

  for (const op of transcriptOperations) {
    const sourcePk = getSourceProjectKeyFromTranscriptSyncKey(op.syncKey);
    if (!sourcePk || !op.conversationId) {
      continue;
    }
    const targetProject = projectMapping.get(sourcePk);
    if (!targetProject) {
      continue;
    }
    const gkey = `${sourcePk}:${op.conversationId}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { sourceProjectKey: sourcePk, conversationId: op.conversationId, targetProject, ops: [] };
      groups.set(gkey, g);
    }
    g.ops.push(op);
  }

  const createdAt = new Date().toISOString();
  const sortedGroups = [...groups.values()].sort((a, b) =>
    a.sourceProjectKey !== b.sourceProjectKey
      ? a.sourceProjectKey.localeCompare(b.sourceProjectKey)
      : a.conversationId.localeCompare(b.conversationId)
  );

  const needsV1Store = sortedGroups.some((g) => {
    const sk = bundleArtifactSyncKey(g.sourceProjectKey, g.conversationId, "store", "store.db");
    return Boolean(gistData.files[syncKeyToGistFileName(sk)]);
  });
  const v1StoreChatsKey = needsV1Store
    ? await resolveV1ImportStoreChatsWorkspaceKey(sortedGroups[0]!.targetProject.folderName)
    : "";

  for (const g of sortedGroups) {
    const storeSyncKey = bundleArtifactSyncKey(
      g.sourceProjectKey,
      g.conversationId,
      "store",
      "store.db"
    );
    const sidebarSyncKey = bundleArtifactSyncKey(
      g.sourceProjectKey,
      g.conversationId,
      "sidebar",
      "sidebar-metadata.json"
    );

    const storeGist = gistData.files[syncKeyToGistFileName(storeSyncKey)];
    if (storeGist && !seenStores.has(storeSyncKey)) {
      seenStores.add(storeSyncKey);
      const storeBuf = decodeTolerantStoreGistContent(storeGist.content);
      if (storeBuf.length > 0) {
        extra.push({
          absolutePath: path.join(
            resolveChatsRoot(),
            v1StoreChatsKey,
            g.conversationId,
            "store.db"
          ),
          content: storeBuf,
          checksum: computeArtifactChecksum(storeBuf),
          syncKey: storeSyncKey,
          kind: "store",
          conversationId: g.conversationId,
        });
      } else {
        logger.appendLine(
          `[${new Date().toISOString()}] V1 import skipped empty store artifact for ${storeSyncKey}`
        );
      }
    }

    if (seenSidebars.has(sidebarSyncKey)) {
      continue;
    }
    seenSidebars.add(sidebarSyncKey);

    const sidebarGist = gistData.files[syncKeyToGistFileName(sidebarSyncKey)];
    let sidebarBuffer: Buffer;
    if (sidebarGist) {
      sidebarBuffer = Buffer.from(sidebarGist.content, "utf-8");
    } else {
      const transcriptRelativePaths = [
        ...new Set(
          g.ops.map((op) => op.syncKey.slice(`transcripts/${g.sourceProjectKey}/`.length))
        ),
      ].sort();
      let primaryContent = g.ops[0]!.content.toString("utf-8");
      let primaryAt = transcriptRelativePaths[0] ?? "";
      for (const op of g.ops) {
        const rel = op.syncKey.slice(`transcripts/${g.sourceProjectKey}/`.length);
        if (path.basename(rel, path.extname(rel)) === g.conversationId) {
          primaryContent = op.content.toString("utf-8");
          primaryAt = rel;
          break;
        }
      }
      const synthetic: ExportConversationState = {
        projectKey: g.sourceProjectKey,
        conversationId: g.conversationId,
        transcriptArtifacts: [],
        transcriptRelativePaths,
        primaryTranscriptContent: primaryContent,
        primaryTranscriptSelectedAt: primaryAt,
        lastUpdatedAt: createdAt,
        warnings: [],
      };
      const snapshot = await buildSidebarMetadataSnapshot(synthetic, createdAt);
      sidebarBuffer = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");
    }

    extra.push({
      absolutePath: path.join(
        g.targetProject.fullPath,
        "agent-transcripts",
        g.conversationId,
        "cursor-sidebar-metadata.json"
      ),
      content: sidebarBuffer,
      checksum: computeArtifactChecksum(sidebarBuffer),
      syncKey: sidebarSyncKey,
      kind: "sidebar",
      conversationId: g.conversationId,
    });
  }

  return [...transcriptOperations, ...extra].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
}

export async function preflightV2ConversationImport(params: {
  gistData: GistResponse;
  manifest: TranscriptManifestV2;
  conversation: TranscriptBundleConversationEntry;
  targetProject: ProjectInfo;
  workspaceMapping: ReadonlyMap<string, string>;
}): Promise<string[]> {
  const { gistData, manifest, conversation, targetProject, workspaceMapping } = params;
  const errors: string[] = [];

  const artifactIds = [
    ...conversation.transcriptArtifacts,
    conversation.sidebarArtifact,
    ...(conversation.storeArtifact ? [conversation.storeArtifact] : []),
  ];

  for (const artifactId of artifactIds) {
    const entry = manifest.artifacts[artifactId];
    if (!entry) {
      errors.push(`Import preflight failed: Missing manifest entry for "${artifactId}".`);
      continue;
    }

    const gistFile = gistData.files[syncKeyToGistFileName(artifactId)];
    if (!gistFile) {
      errors.push(`Import preflight failed: Bundle file missing for "${artifactId}".`);
      continue;
    }

    let content: Buffer;
    try {
      content = decodeTranscriptArtifact(gistFile.content, entry.encoding);
    } catch {
      errors.push(`Import preflight failed: Failed to decode artifact "${artifactId}".`);
      continue;
    }

    const checksum = computeArtifactChecksum(content);
    if (checksum !== entry.checksum) {
      errors.push(`Import preflight failed: Checksum mismatch for "${artifactId}".`);
    }

    if (entry.kind === "store") {
      const swk = entry.sourceWorkspaceKey;
      if (typeof swk !== "string" || swk.length === 0) {
        errors.push(
          `Import preflight failed: Store "${artifactId}" has no sourceWorkspaceKey; re-export with Cursor Sync or deselect this conversation.`
        );
      } else {
        const mapped = workspaceMapping.get(swk);
        if (typeof mapped !== "string" || mapped.length === 0) {
          errors.push(
            `Import preflight failed: Store "${artifactId}": map source workspace "${swk}" to a local chats key.`
          );
        } else if (!isSafeWorkspaceKeySegment(mapped)) {
          errors.push(
            `Import preflight failed: Store destination workspace key "${mapped}" is not a safe path segment.`
          );
        } else {
          const parent = path.join(resolveChatsRoot(), mapped);
          try {
            await fs.mkdir(parent, { recursive: true });
          } catch {
            errors.push(
              `Import preflight failed: Cannot create or access chats directory "${parent}" for store restore.`
            );
          }
        }
      }
    }
  }

  try {
    await fs.access(targetProject.fullPath);
  } catch {
    errors.push(`Import preflight failed: Target project directory missing: ${targetProject.fullPath}.`);
  }

  try {
    await fs.mkdir(resolveChatsRoot(), { recursive: true });
  } catch {
    errors.push(`Import preflight failed: Cannot access chats root ${resolveChatsRoot()}.`);
  }

  return errors;
}
