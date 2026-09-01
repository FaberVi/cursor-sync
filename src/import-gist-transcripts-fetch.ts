import { GistClient } from "./gist.js";
import {
  computeArtifactChecksum,
  gistFileNameToSyncKey,
  type TranscriptBundleManifest,
  type TranscriptManifestV1,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import { extractGistId as extractGistIdFromExport } from "./transcripts-export.js";

export interface DiscoveredTranscript {
  conversationId: string;
  projectKey: string;
  content: string;
  checksum: string;
  sizeBytes: number;
  gistFileName: string;
}

export async function fetchGist(
  gistId: string,
  token: string | undefined
): Promise<{ files?: Record<string, { content?: string }> } | null> {
  // If a token is available, pass it to the client to ensure authenticated requests.
  // Do not pass an undefined token to the constructor when no token exists.
  const gistClient = token ? new GistClient(token) : new GistClient();
  const result = await gistClient.getGist(gistId);
  if (!result.ok) {
    // Provide actionable, user-friendly messages based on the API error.
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
      throw new Error(result.error?.message ?? `Network error while fetching Gist`);
    }
    // Fallback generic error
    throw new Error(result.error?.message ?? `Failed to fetch Gist: ${status ?? 0}`);
  }
  return result.data as { files?: Record<string, { content?: string }> };
}

/**
 * Gist URL/ID parser used by transcript gist import.
 * Delegates to {@link extractGistIdFromExport} (hex gist ids) after the same
 * URL/bare-id shape checks previously local to this module.
 */
export function extractGistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const fromExport = extractGistIdFromExport(trimmed);
  if (fromExport) return fromExport;

  const urlMatch = trimmed.match(/gist\.github\.com\/[^/]+\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1]!;

  if (/^[A-Za-z0-9-]+$/.test(trimmed)) return trimmed;

  return null;
}

export function discoverTranscripts(
  manifest: TranscriptBundleManifest,
  gist: { files?: Record<string, { content?: string }> }
): DiscoveredTranscript[] {
  const transcripts: DiscoveredTranscript[] = [];

  if (manifest.schemaVersion === 1) {
    const v1 = manifest as TranscriptManifestV1;
    for (const [gistFileName, entry] of Object.entries(v1.files)) {
      if (!gistFileName.endsWith(".jsonl")) continue;

      const content = gist.files?.[gistFileName]?.content;
      if (!content) continue;

      const syncKey = gistFileNameToSyncKey(gistFileName);
      // Format: transcripts/<projectKey>/<conversationId>/<conversationId>.jsonl
      const parts = syncKey.split("/");
      if (parts.length < 3) continue;

      const projectKey = parts[1]!;
      const conversationId = parts[2]!;

      const buf = Buffer.from(content, "utf-8");
      const checksum = computeArtifactChecksum(buf);

      transcripts.push({
        conversationId,
        projectKey,
        content,
        checksum,
        sizeBytes: buf.length,
        gistFileName,
      });
    }
  } else if (manifest.schemaVersion === 2) {
    const v2 = manifest as TranscriptManifestV2;
    for (const [artifactKey, artifact] of Object.entries(v2.artifacts)) {
      if (artifact.kind !== "transcript") continue;

      const gistFileName = artifactKey.replace(/\//g, "--");
      const content = gist.files?.[gistFileName]?.content;
      if (!content) continue;

      const buf = Buffer.from(content, "utf-8");
      const checksum = computeArtifactChecksum(buf);

      transcripts.push({
        conversationId: artifact.conversationId,
        projectKey: artifact.projectKey,
        content,
        checksum,
        sizeBytes: buf.length,
        gistFileName,
      });
    }
  }

  return transcripts;
}
