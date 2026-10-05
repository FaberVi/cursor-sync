import type { ChatBundle } from "../chat-persistence.js";
import {
  applyRichComposerEntryToPartialState,
  partialStateHasConversationContent,
  type PartialState,
} from "../chat-partial-state.js";
import { chatBundleFromNativeChatJson } from "./bundle-bridge.js";
import type { NativeChatJsonDocument } from "./types.js";

export function hydratePartialStateFromNativeDoc(
  partial: PartialState,
  doc: NativeChatJsonDocument,
  conversationId: string
): boolean {
  const bundle = chatBundleFromNativeChatJson(doc);
  return hydratePartialStateFromBundleDiskKv(partial, bundle, conversationId);
}

export function hydratePartialStateFromBundleDiskKv(
  partial: PartialState,
  bundle: ChatBundle,
  conversationId: string
): boolean {
  const snap = bundle.diskKvSnapshot;
  if (!snap?.rows?.length) {
    return false;
  }
  const composerRow = snap.rows.find((r) => r.key === `composerData:${conversationId}`);
  if (!composerRow) {
    return false;
  }
  try {
    const entry = JSON.parse(composerRow.value) as Record<string, unknown>;
    applyRichComposerEntryToPartialState(partial, entry, conversationId);
    const headers = partial.fullConversationHeadersOnly;
    if (!Array.isArray(headers) || headers.length === 0) {
      const built: Array<Record<string, unknown>> = [];
      for (const row of snap.rows) {
        if (!row.key.startsWith(`bubbleId:${conversationId}:`)) {
          continue;
        }
        const bubbleId = row.key.split(":").pop() ?? "";
        let bubble: Record<string, unknown> = {};
        try {
          bubble = JSON.parse(row.value) as Record<string, unknown>;
        } catch {
          bubble = { text: row.value };
        }
        built.push({
          bubbleId: typeof bubble.bubbleId === "string" ? bubble.bubbleId : bubbleId,
          type: bubble.type ?? 1,
        });
      }
      if (built.length > 0) {
        partial.fullConversationHeadersOnly = built;
      }
    }
    return partialStateHasConversationContent(partial);
  } catch {
    return false;
  }
}
