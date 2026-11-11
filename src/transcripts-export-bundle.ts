import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  TRANSCRIPT_MANIFEST_FILE_NAME,
  bundleArtifactSyncKey,
  computeArtifactChecksum,
  computeTranscriptMachineId,
  encodeTranscriptArtifact,
  getConversationIdFromRelativePath,
  getConversationScopedRelativePath,
  syncKeyToGistFileName,
  summarizeTranscriptForSidebar,
  type TranscriptBundleArtifactEntry,
  type TranscriptBundleConversationEntry,
  type TranscriptBundleSourceProjectInfo,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import { findStoreDbForConversation } from "./transcripts-cursor-paths.js";
import { buildSidebarMetadataSnapshot } from "./transcripts-import-sidebar.js";
import type { ExportConversationCandidate, ProjectInfo } from "./transcripts-discovery.js";
import type {
  ExportConversationState,
  ExportProjectAccumulator,
} from "./transcripts-internal-types.js";

function toSortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export async function buildExportBundleV2(
  conversationPlans: ExportConversationCandidate[],
  selectedProjects: ProjectInfo[]
): Promise<{ gistFiles: Record<string, { content: string }>; manifest: TranscriptManifestV2 }> {
  const createdAt = new Date().toISOString();
  const artifactContents = new Map<string, { content: string }>();
  const artifactEntries = new Map<string, TranscriptBundleArtifactEntry>();
  const conversationStates = new Map<string, ExportConversationState>();
  const projectAccumulators = new Map<string, ExportProjectAccumulator>();
  const globalWarnings = new Set<string>();

  for (const project of selectedProjects) {
    projectAccumulators.set(project.folderName, {
      folderName: project.folderName,
      fileCount: 0,
      conversationIds: new Set<string>(),
      artifactCount: 0,
    });
  }

  const sortedPlans = [...conversationPlans].sort((a, b) => {
    const pc = a.projectKey.localeCompare(b.projectKey);
    return pc !== 0 ? pc : a.conversationId.localeCompare(b.conversationId);
  });

  for (const plan of sortedPlans) {
    const conversationKey = `${plan.projectKey}:${plan.conversationId}`;
    const sortedFiles = [...plan.transcriptFiles].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    );

    for (const file of sortedFiles) {
      const fileBuffer = await fs.readFile(file.absolutePath);
      const fileContent = fileBuffer.toString("utf-8");
      const conversationId = getConversationIdFromRelativePath(file.relativePath);
      const projectAccumulator = projectAccumulators.get(file.projectKey) ?? {
        folderName: file.projectKey,
        fileCount: 0,
        conversationIds: new Set<string>(),
        artifactCount: 0,
      };

      projectAccumulator.fileCount += 1;
      projectAccumulator.conversationIds.add(conversationId);
      projectAccumulators.set(file.projectKey, projectAccumulator);

      const stat = await fs.stat(file.absolutePath);
      const fileUpdatedAt = stat.mtime.toISOString();
      const conversationState = conversationStates.get(conversationKey) ?? {
        projectKey: plan.projectKey,
        conversationId: plan.conversationId,
        transcriptArtifacts: [],
        transcriptRelativePaths: [],
        primaryTranscriptContent: fileContent,
        primaryTranscriptSelectedAt: "",
        lastUpdatedAt: fileUpdatedAt,
        warnings: [],
      };

      if (
        conversationState.primaryTranscriptSelectedAt.length === 0 ||
        path.basename(file.relativePath) === `${conversationId}.jsonl`
      ) {
        conversationState.primaryTranscriptContent = fileContent;
        conversationState.primaryTranscriptSelectedAt = file.relativePath;
      }

      if (fileUpdatedAt > conversationState.lastUpdatedAt) {
        conversationState.lastUpdatedAt = fileUpdatedAt;
      }

      conversationState.transcriptRelativePaths.push(file.relativePath);

      const scopedRelativePath =
        getConversationScopedRelativePath(file.relativePath) || path.basename(file.relativePath);
      const artifactKey = bundleArtifactSyncKey(
        file.projectKey,
        conversationId,
        "transcript",
        scopedRelativePath
      );

      artifactContents.set(artifactKey, {
        content: fileContent,
      });
      artifactEntries.set(artifactKey, {
        projectKey: file.projectKey,
        conversationId,
        kind: "transcript",
        checksum: computeArtifactChecksum(fileBuffer),
        sizeBytes: fileBuffer.length,
        contentType: "application/x-jsonlines",
        sourceRelativePath: file.relativePath,
      });
      conversationState.transcriptArtifacts.push(artifactKey);
      conversationStates.set(conversationKey, conversationState);
    }

    if (!conversationStates.has(conversationKey)) {
      conversationStates.set(conversationKey, {
        projectKey: plan.projectKey,
        conversationId: plan.conversationId,
        transcriptArtifacts: [],
        transcriptRelativePaths: [],
        primaryTranscriptContent: "",
        primaryTranscriptSelectedAt: "",
        lastUpdatedAt: createdAt,
        warnings: [],
      });
      const pa = projectAccumulators.get(plan.projectKey);
      if (pa) {
        pa.conversationIds.add(plan.conversationId);
      }
    }
  }

  const conversationRecords = new Map<string, TranscriptBundleConversationEntry>();
  const sortedConversationKeys = [...conversationStates.keys()].sort();

  for (const conversationKey of sortedConversationKeys) {
    const conversationState = conversationStates.get(conversationKey);
    if (!conversationState) {
      continue;
    }

    const projectAccumulator = projectAccumulators.get(conversationState.projectKey);
    const storeSnapshot = await findStoreDbForConversation(conversationState.conversationId);
    if (storeSnapshot) {
      const storeBuffer = await fs.readFile(storeSnapshot.absolutePath);
      const encoded = encodeTranscriptArtifact(storeBuffer, true);
      const storeArtifactKey = bundleArtifactSyncKey(
        conversationState.projectKey,
        conversationState.conversationId,
        "store",
        "store.db"
      );

      artifactContents.set(storeArtifactKey, { content: encoded.content });
      artifactEntries.set(storeArtifactKey, {
        projectKey: conversationState.projectKey,
        conversationId: conversationState.conversationId,
        kind: "store",
        checksum: computeArtifactChecksum(storeBuffer),
        sizeBytes: storeBuffer.length,
        contentType: "application/octet-stream",
        encoding: encoded.encoding,
        sourceWorkspaceKey: storeSnapshot.workspaceKey,
      });
      conversationState.storeArtifact = storeArtifactKey;
      conversationState.sourceWorkspaceKey = storeSnapshot.workspaceKey;
      if (projectAccumulator) {
        projectAccumulator.artifactCount += 1;
      }
    } else {
      conversationState.warnings.push(
        "Store snapshot was not found under ~/.cursor/chats; transcript JSONL will still be exported."
      );
    }

    const sidebarSnapshot = await buildSidebarMetadataSnapshot(conversationState, createdAt);
    const sidebarBuffer = Buffer.from(JSON.stringify(sidebarSnapshot, null, 2), "utf-8");
    const sidebarArtifactKey = bundleArtifactSyncKey(
      conversationState.projectKey,
      conversationState.conversationId,
      "sidebar",
      "sidebar-metadata.json"
    );

    artifactContents.set(sidebarArtifactKey, {
      content: sidebarBuffer.toString("utf-8"),
    });
    artifactEntries.set(sidebarArtifactKey, {
      projectKey: conversationState.projectKey,
      conversationId: conversationState.conversationId,
      kind: "sidebar",
      checksum: computeArtifactChecksum(sidebarBuffer),
      sizeBytes: sidebarBuffer.length,
      contentType: "application/json",
    });

    const summary = summarizeTranscriptForSidebar(
      conversationState.primaryTranscriptContent,
      conversationState.conversationId
    );
    const lastUpdatedAt =
      summary.lastUpdatedAt ?? conversationState.lastUpdatedAt ?? createdAt;

    conversationRecords.set(conversationKey, {
      projectKey: conversationState.projectKey,
      conversationId: conversationState.conversationId,
      title: summary.title,
      subtitle: summary.subtitle,
      previewText: summary.previewText,
      lastUpdatedAt,
      transcriptArtifacts: [...conversationState.transcriptArtifacts].sort(),
      storeArtifact: conversationState.storeArtifact,
      ...(conversationState.sourceWorkspaceKey
        ? { storeSourceWorkspaceKey: conversationState.sourceWorkspaceKey }
        : {}),
      sidebarArtifact: sidebarArtifactKey,
      warnings: [...conversationState.warnings].sort(),
    });

    if (projectAccumulator) {
      projectAccumulator.artifactCount += conversationState.transcriptArtifacts.length + 1;
    }

    for (const warning of conversationState.warnings) {
      globalWarnings.add(
        `${conversationState.projectKey}/${conversationState.conversationId}: ${warning}`
      );
    }
  }

  const sourceProjects = toSortedRecord(
    [...projectAccumulators.entries()].map(([projectKey, accumulator]) => [
      projectKey,
      {
        folderName: accumulator.folderName,
        fileCount: accumulator.fileCount,
        conversationCount: accumulator.conversationIds.size,
        artifactCount: accumulator.artifactCount,
      } satisfies TranscriptBundleSourceProjectInfo,
    ])
  );

  const artifacts = toSortedRecord([...artifactEntries.entries()]);
  const conversations = toSortedRecord([...conversationRecords.entries()]);
  const manifest: TranscriptManifestV2 = {
    schemaVersion: 2,
    type: "agent-transcripts",
    createdAt,
    sourceMachineId: computeTranscriptMachineId(),
    sourceOS: process.platform,
    sourceProjects,
    artifacts,
    conversations,
    warnings: [...globalWarnings].sort(),
  };

  const gistFiles: Record<string, { content: string }> = {};
  for (const [artifactKey, file] of [...artifactContents.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    gistFiles[syncKeyToGistFileName(artifactKey)] = file;
  }

  gistFiles[TRANSCRIPT_MANIFEST_FILE_NAME] = {
    content: JSON.stringify(manifest, null, 2),
  };

  return { gistFiles, manifest };
}
