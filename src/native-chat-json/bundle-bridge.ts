import * as crypto from "node:crypto";
import type { ChatBundle } from "../chat-persistence.js";
import type { NativeChatJsonDocument } from "./types.js";

function sha256HexUtf8(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

export function nativeChatJsonFromBundle(bundle: ChatBundle): NativeChatJsonDocument {
  let conversationState = "~";
  const blobs: NativeChatJsonDocument["blobs"] = [];
  const snap = bundle.diskKvSnapshot;

  if (snap?.rows) {
    for (const row of snap.rows) {
      if (row.key === `composerData:${bundle.conversationId}`) {
        try {
          const composer = JSON.parse(row.value) as Record<string, unknown>;
          const cs = composer.conversationState;
          if (typeof cs === "string" && cs.length > 0) {
            conversationState = cs;
          }
        } catch {
          /* keep default */
        }
        continue;
      }
      if (row.key.startsWith(`bubbleId:${bundle.conversationId}:`)) {
        const hash = row.key.split(":").pop() ?? sha256HexUtf8(row.value);
        blobs.push({
          hash,
          content: Buffer.from(row.value, "utf-8").toString("base64"),
        });
      }
    }
  }

  const doc: NativeChatJsonDocument = {
    version: 1,
    conversationId: bundle.conversationId,
    conversationState,
    blobs,
    title: bundle.title,
    subtitle: bundle.subtitle,
    previewText: bundle.previewText,
    createdAt: bundle.createdAt,
  };

  if (bundle.storeSnapshot) {
    doc.storeDb = {
      content: bundle.storeSnapshot.content,
      encoding: bundle.storeSnapshot.encoding,
      checksum: bundle.storeSnapshot.checksum,
      sizeBytes: bundle.storeSnapshot.sizeBytes,
      sourceWorkspaceKey: bundle.storeSnapshot.sourceWorkspaceKey,
    };
  }
  if (bundle.sidebarSnapshot) {
    doc.sidebar = bundle.sidebarSnapshot;
  }
  if (bundle.diskKvSnapshot) {
    doc.diskKv = bundle.diskKvSnapshot;
  }
  if (bundle.transcriptFiles.length > 0) {
    doc.transcripts = bundle.transcriptFiles.map((t) => ({
      relativePath: t.relativePath,
      content: t.content,
      checksum: t.checksum,
      sizeBytes: t.sizeBytes,
      encoding: t.encoding,
    }));
  }
  return doc;
}

export function chatBundleFromNativeChatJson(doc: NativeChatJsonDocument): ChatBundle {
  let diskKvSnapshot = doc.diskKv ?? null;
  if (!diskKvSnapshot && (doc.blobs.length > 0 || doc.conversationState !== "~")) {
    const rows: NonNullable<ChatBundle["diskKvSnapshot"]>["rows"] = [];
    const composerEntry: Record<string, unknown> = {
      composerId: doc.conversationId,
      name: doc.title ?? doc.conversationId,
      conversationState: doc.conversationState,
      fullConversationHeadersOnly: [],
      conversationMap: {},
    };
    for (const blob of doc.blobs) {
      let value: string;
      try {
        value = Buffer.from(blob.content, "base64").toString("utf-8");
      } catch {
        value = blob.content;
      }
      rows.push({
        key: `bubbleId:${doc.conversationId}:${blob.hash}`,
        value,
        checksum: sha256HexUtf8(value),
      });
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const bubbleId =
          typeof parsed.bubbleId === "string" ? parsed.bubbleId : blob.hash;
        const headers = composerEntry.fullConversationHeadersOnly as Array<
          Record<string, unknown>
        >;
        headers.push({
          bubbleId,
          type: parsed.type ?? 1,
        });
      } catch {
        /* text bubble */
      }
    }
    rows.unshift({
      key: `composerData:${doc.conversationId}`,
      value: JSON.stringify(composerEntry),
      checksum: sha256HexUtf8(JSON.stringify(composerEntry)),
    });
    diskKvSnapshot = {
      sourceStateDbPath: "",
      rows,
      rowCount: rows.length,
      toolBubbleCount: rows.filter((r) => {
        if (!r.key.startsWith(`bubbleId:${doc.conversationId}:`)) {
          return false;
        }
        try {
          return !!(JSON.parse(r.value) as Record<string, unknown>).toolFormerData;
        } catch {
          return false;
        }
      }).length,
    };
  }

  const transcriptFiles =
    doc.transcripts?.map((t) => ({
      relativePath: t.relativePath,
      content: t.content,
      checksum: t.checksum,
      sizeBytes: t.sizeBytes,
      encoding: t.encoding,
    })) ?? [];

  return {
    schemaVersion: diskKvSnapshot ? 2 : 1,
    type: "chat-persistence",
    createdAt: doc.createdAt ?? new Date().toISOString(),
    conversationId: doc.conversationId,
    title: doc.title ?? doc.conversationId,
    subtitle: doc.subtitle ?? "",
    previewText: doc.previewText ?? "",
    sidebarSnapshot: doc.sidebar ?? null,
    storeSnapshot: doc.storeDb
      ? {
          content: doc.storeDb.content,
          encoding: doc.storeDb.encoding,
          checksum: doc.storeDb.checksum,
          sizeBytes: doc.storeDb.sizeBytes,
          sourceWorkspaceKey: doc.storeDb.sourceWorkspaceKey ?? "",
        }
      : null,
    transcriptFiles,
    diskKvSnapshot,
  };
}
