import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import type { ChatBundle } from "./chat-persistence.js";

export function logChatRestoreDebug(line: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] [chat-restore-debug] ${line}`);
}

export function composerPayloadDebug(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return "absent";
  }
  const list = payload.allComposers;
  if (!Array.isArray(list)) {
    return "present keys=" + Object.keys(payload).join(",");
  }
  const ids = list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c))
    .map((c) => (typeof c.composerId === "string" ? c.composerId : ""))
    .filter((id) => id.length > 0);
  return `allComposers=${list.length} composerIds=[${ids.join(",")}]`;
}

export function bundleArtifactsDebug(bundle: ChatBundle): string {
  const tfSummary =
    bundle.transcriptFiles.length === 0
      ? "none"
      : bundle.transcriptFiles
          .map((t) => `${path.basename(t.relativePath)}:${t.sizeBytes}b`)
          .join(",");
  const store = bundle.storeSnapshot
    ? `present ${bundle.storeSnapshot.sizeBytes}b src=${bundle.storeSnapshot.sourceWorkspaceKey}`
    : "absent";
  const sidebar = bundle.sidebarSnapshot
    ? `present keys=${Object.keys(bundle.sidebarSnapshot).join(",")}`
    : "absent";
  return `transcriptFiles=${bundle.transcriptFiles.length} [${tfSummary}] storeSnapshot=${store} sidebarSnapshot=${sidebar}`;
}
