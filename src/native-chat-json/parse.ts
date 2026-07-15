import {
  NATIVE_CHAT_JSON_VERSION,
  type NativeChatJsonDocument,
} from "./types.js";

export function isNativeChatJsonDocument(value: unknown): value is NativeChatJsonDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  if (doc.version !== NATIVE_CHAT_JSON_VERSION) {
    return false;
  }
  if (typeof doc.conversationId !== "string" || !doc.conversationId.trim()) {
    return false;
  }
  if (typeof doc.conversationState !== "string") {
    return false;
  }
  if (!Array.isArray(doc.blobs)) {
    return false;
  }
  for (const blob of doc.blobs) {
    if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
      return false;
    }
    const b = blob as Record<string, unknown>;
    if (typeof b.hash !== "string" || typeof b.content !== "string") {
      return false;
    }
  }
  return true;
}

export function parseNativeChatJson(raw: string): NativeChatJsonDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid native chat JSON: ${msg}`);
  }
  if (!isNativeChatJsonDocument(parsed)) {
    throw new Error(
      "Invalid native chat JSON: expected version 1 with conversationState and blobs."
    );
  }
  return parsed;
}

export function isLegacyChatBundleDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  return doc.type === "chat-persistence" && typeof doc.schemaVersion === "number";
}
