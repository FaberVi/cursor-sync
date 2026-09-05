import { emitChatImportProgress } from "../chat-progress-events.js";
import {
  formatFidelityDetailLine,
  type ChatBundleFidelitySummary,
} from "../chat-bundle-fidelity.js";
import type { ChatImportHistoryEntry } from "./import-history.js";

export function publishImportFidelitySummary(
  conversationId: string,
  summary: ChatBundleFidelitySummary
): void {
  emitChatImportProgress({
    conversationId,
    phase: "B",
    step: "fidelity-summary",
    detail: formatFidelityDetailLine(summary),
    ok: !summary.textOnlyLayer4,
    fidelity: summary,
  });
}

export function fidelityFieldsForImportHistory(
  summary: ChatBundleFidelitySummary
): Pick<
  ChatImportHistoryEntry,
  "schemaVersion" | "diskKvRowCount" | "toolBubbleCount" | "textOnlyLayer4" | "fidelityWarnings"
> {
  return {
    schemaVersion: summary.schemaVersion,
    diskKvRowCount: summary.diskKvRowCount,
    toolBubbleCount: summary.toolBubbleCount,
    textOnlyLayer4: summary.textOnlyLayer4,
    fidelityWarnings: summary.warnings.length > 0 ? summary.warnings : undefined,
  };
}
