import * as vscode from "vscode";
import type { ChatBundle, ChatBundleDiskKvSnapshot } from "./chat-persistence.js";

function validateDiskKvSnapshot(
  snapshot: unknown,
  label: string
): ChatBundleDiskKvSnapshot | undefined {
  if (snapshot === undefined || snapshot === null) {
    return undefined;
  }
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new Error(`${label}: diskKvSnapshot must be an object.`);
  }
  const snap = snapshot as Record<string, unknown>;
  if (typeof snap.sourceStateDbPath !== "string" || !snap.sourceStateDbPath) {
    throw new Error(`${label}: diskKvSnapshot.sourceStateDbPath must be a non-empty string.`);
  }
  if (!Array.isArray(snap.rows)) {
    throw new Error(`${label}: diskKvSnapshot.rows must be an array.`);
  }
  const rows = snap.rows.map((row, i) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`${label}: diskKvSnapshot.rows[${i}] must be an object.`);
    }
    const r = row as Record<string, unknown>;
    if (typeof r.key !== "string" || !r.key) {
      throw new Error(`${label}: diskKvSnapshot.rows[${i}].key must be a non-empty string.`);
    }
    if (typeof r.value !== "string") {
      throw new Error(`${label}: diskKvSnapshot.rows[${i}].value must be a string.`);
    }
    if (typeof r.checksum !== "string" || !r.checksum) {
      throw new Error(`${label}: diskKvSnapshot.rows[${i}].checksum must be a non-empty string.`);
    }
    return { key: r.key, value: r.value, checksum: r.checksum };
  });
  if (typeof snap.rowCount !== "number" || !Number.isFinite(snap.rowCount)) {
    throw new Error(`${label}: diskKvSnapshot.rowCount must be a number.`);
  }
  if (typeof snap.toolBubbleCount !== "number" || !Number.isFinite(snap.toolBubbleCount)) {
    throw new Error(`${label}: diskKvSnapshot.toolBubbleCount must be a number.`);
  }
  return {
    sourceStateDbPath: snap.sourceStateDbPath,
    rows,
    rowCount: snap.rowCount,
    toolBubbleCount: snap.toolBubbleCount,
  };
}

export const CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json";
export const CHAT_BUNDLES_GIST_FILE_NAME = "chat-bundles.json";

export interface ChatBundlesCollection {
  schemaVersion: 1;
  type: "chat-bundles-collection";
  createdAt: string;
  sourceWorkspaceKey: string;
  bundles: ChatBundle[];
}

export type ParsedChatExport =
  | { kind: "single"; bundle: ChatBundle }
  | { kind: "collection"; collection: ChatBundlesCollection };

function validateSingleBundle(bundle: Partial<ChatBundle>, label: string): ChatBundle {
  if (bundle.type !== "chat-persistence") {
    throw new Error(
      `${label}: expected type "chat-persistence", got "${String(bundle.type)}".`
    );
  }
  const schemaVersion = bundle.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error(
      `${label}: unsupported schema version ${String(schemaVersion)}.`
    );
  }
  if (!bundle.conversationId || typeof bundle.conversationId !== "string") {
    throw new Error(`${label}: missing conversationId.`);
  }
  const diskKvSnapshot = validateDiskKvSnapshot(bundle.diskKvSnapshot, label);
  const validated: ChatBundle = {
    ...(bundle as ChatBundle),
    schemaVersion: schemaVersion as 1 | 2,
    type: "chat-persistence",
    conversationId: bundle.conversationId,
  };
  if (diskKvSnapshot !== undefined) {
    validated.diskKvSnapshot = diskKvSnapshot;
  }
  return validated;
}

export function buildChatBundlesCollection(
  sourceWorkspaceKey: string,
  bundles: ChatBundle[]
): ChatBundlesCollection {
  if (bundles.length < 1) {
    throw new Error("Cannot build collection with zero bundles.");
  }
  for (const b of bundles) {
    validateSingleBundle(b, "bundle");
  }
  return {
    schemaVersion: 1,
    type: "chat-bundles-collection",
    createdAt: new Date().toISOString(),
    sourceWorkspaceKey,
    bundles,
  };
}

export function parseChatBundleOrCollection(raw: string): ParsedChatExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid chat export JSON: not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid chat export JSON: expected an object.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "chat-persistence") {
    return { kind: "single", bundle: validateSingleBundle(obj as Partial<ChatBundle>, "chat bundle") };
  }
  if (obj.type === "chat-bundles-collection") {
    const col = obj as Partial<ChatBundlesCollection>;
    if (col.schemaVersion !== 1) {
      throw new Error(`Invalid collection schema version: ${String(col.schemaVersion)}.`);
    }
    const bundles = col.bundles;
    if (!Array.isArray(bundles) || bundles.length === 0) {
      throw new Error("Invalid chat bundles collection: bundles array is empty.");
    }
    const validated = bundles.map((b, i) =>
      validateSingleBundle(b as Partial<ChatBundle>, `bundles[${i}]`)
    );
    return {
      kind: "collection",
      collection: {
        schemaVersion: 1,
        type: "chat-bundles-collection",
        createdAt: String(col.createdAt ?? new Date().toISOString()),
        sourceWorkspaceKey: String(col.sourceWorkspaceKey ?? ""),
        bundles: validated,
      },
    };
  }
  throw new Error(
    `Invalid chat export: expected type "chat-persistence" or "chat-bundles-collection", got "${String(obj.type)}".`
  );
}

export function selectGistExportFile(
  bundleCount: number,
  singleOrCollection?: ChatBundle | ChatBundlesCollection
): { fileName: string; content: string } {
  if (bundleCount <= 1) {
    const bundle = singleOrCollection as ChatBundle;
    return {
      fileName: CHAT_BUNDLE_GIST_FILE_NAME,
      content: JSON.stringify(bundle, null, 2),
    };
  }
  const collection = singleOrCollection as ChatBundlesCollection;
  return {
    fileName: CHAT_BUNDLES_GIST_FILE_NAME,
    content: JSON.stringify(collection, null, 2),
  };
}

export function defaultLocalExportFilename(
  conversationIds: string[],
  timestamp: string
): string {
  if (conversationIds.length === 1) {
    const safe = conversationIds[0]!.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    return `${safe}-chat-bundle.json`;
  }
  return `chat-bundles-${timestamp}.json`;
}

export function defaultGlobalStorageFilename(timestamp: string, multi: boolean): string | undefined {
  return multi ? `chat-bundles_${timestamp}.json` : undefined;
}

export async function pickBundleFromCollection(
  collection: ChatBundlesCollection
): Promise<ChatBundle | null> {
  const pick = await vscode.window.showQuickPick(
    collection.bundles.map((b) => ({
      label: b.title,
      description: b.conversationId,
      detail: b.subtitle,
    })),
    {
      title: "Select chat to import",
      placeHolder: "This export contains multiple conversations",
      ignoreFocusOut: true,
    }
  );
  if (!pick?.description) return null;
  return collection.bundles.find((b) => b.conversationId === pick.description) ?? null;
}
