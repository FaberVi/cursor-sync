/** Native Cursor chat JSON transport (v0.8+). */

import type { TranscriptBundleArtifactEncoding } from "../transcript-bundle.js";
import type { ChatBundleDiskKvSnapshot } from "../chat-persistence.js";

export const NATIVE_CHAT_JSON_VERSION = 1 as const;
export const NATIVE_CHAT_COLLECTION_TYPE = "cursor-chat-collection" as const;

export interface NativeChatJsonBlob {
  hash: string;
  content: string;
}

export interface NativeChatJsonStoreDb {
  content: string;
  encoding: TranscriptBundleArtifactEncoding;
  checksum: string;
  sizeBytes: number;
  sourceWorkspaceKey?: string;
}

export interface NativeChatJsonTranscript {
  relativePath: string;
  content: string;
  checksum: string;
  sizeBytes: number;
  encoding?: TranscriptBundleArtifactEncoding;
}

export interface NativeChatJsonDocument {
  version: typeof NATIVE_CHAT_JSON_VERSION;
  conversationId: string;
  conversationState: string;
  blobs: NativeChatJsonBlob[];
  title?: string;
  subtitle?: string;
  previewText?: string;
  createdAt?: string;
  storeDb?: NativeChatJsonStoreDb;
  sidebar?: Record<string, unknown> | null;
  diskKv?: ChatBundleDiskKvSnapshot | null;
  transcripts?: NativeChatJsonTranscript[];
}

export interface NativeChatCollection {
  version: typeof NATIVE_CHAT_JSON_VERSION;
  type: typeof NATIVE_CHAT_COLLECTION_TYPE;
  createdAt: string;
  chats: NativeChatJsonDocument[];
}
