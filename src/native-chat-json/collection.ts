import type { ChatBundle } from "../chat-persistence.js";
import { chatBundleFromNativeChatJson, nativeChatJsonFromBundle } from "./bundle-bridge.js";
import { isNativeChatJsonDocument } from "./parse.js";
import {
  NATIVE_CHAT_COLLECTION_TYPE,
  NATIVE_CHAT_JSON_VERSION,
  type NativeChatCollection,
  type NativeChatJsonDocument,
} from "./types.js";

export function buildNativeChatCollection(
  chats: NativeChatJsonDocument[],
  createdAt?: string
): NativeChatCollection {
  return {
    version: NATIVE_CHAT_JSON_VERSION,
    type: NATIVE_CHAT_COLLECTION_TYPE,
    createdAt: createdAt ?? new Date().toISOString(),
    chats: [...chats].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
  };
}

export function nativeCollectionFromBundles(bundles: ChatBundle[]): NativeChatCollection {
  return buildNativeChatCollection(bundles.map(nativeChatJsonFromBundle));
}

export function bundlesFromNativeCollection(collection: NativeChatCollection): ChatBundle[] {
  return collection.chats.map(chatBundleFromNativeChatJson);
}

export function isNativeChatCollection(value: unknown): value is NativeChatCollection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  return (
    doc.version === NATIVE_CHAT_JSON_VERSION &&
    doc.type === NATIVE_CHAT_COLLECTION_TYPE &&
    Array.isArray(doc.chats) &&
    doc.chats.every((c) => isNativeChatJsonDocument(c))
  );
}

export function parseNativeChatCollection(raw: string): NativeChatCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid native chat collection JSON: ${msg}`);
  }
  if (isNativeChatCollection(parsed)) {
    return parsed;
  }
  if (isNativeChatJsonDocument(parsed)) {
    return buildNativeChatCollection([parsed]);
  }
  throw new Error(
    'Expected native cursor-chat collection (type "cursor-chat-collection") or single chat document.'
  );
}

export function nativeChatTimestamp(doc: NativeChatJsonDocument): number {
  const raw = doc.createdAt;
  if (!raw) {
    return 0;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export function mergeNativeChatCollections(
  remote: NativeChatJsonDocument[],
  local: NativeChatJsonDocument[]
): NativeChatJsonDocument[] {
  const byId = new Map<string, NativeChatJsonDocument>();
  for (const doc of remote) {
    byId.set(doc.conversationId, doc);
  }
  for (const doc of local) {
    const existing = byId.get(doc.conversationId);
    if (!existing || nativeChatTimestamp(doc) >= nativeChatTimestamp(existing)) {
      byId.set(doc.conversationId, doc);
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.conversationId.localeCompare(b.conversationId)
  );
}
