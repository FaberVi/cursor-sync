import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { escapeSqlLiteral } from "./composer-merge.js";
import type { ChatsManifestChat, ChatMessageEntry } from "./chats-manifest.js";
import {
  decodeTranscriptArtifact,
  type TranscriptBundleArtifactEncoding,
} from "./transcript-bundle.js";

export interface BundleForStoreHydrate {
  conversationId: string;
  title: string;
  previewText: string;
  createdAt: string;
  transcriptFiles: Array<{
    content: string;
    encoding?: TranscriptBundleArtifactEncoding;
  }>;
}
import { getChatTimestampMs } from "./chats-manifest.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { runSqliteScript, querySqliteRows } = __chatPersistenceInternals;

export const GOLDEN_STORE_TEMPLATE_VERSION = 2;

export const GOLDEN_TEMPLATE_CAPTURED_FOR_CURSOR = "regenerate via resources/golden-store-template.sql";

export async function readTemplateUserVersion(dbPath: string): Promise<number | undefined> {
  try {
    const rows = await querySqliteRows(dbPath, "PRAGMA user_version;");
    const v = rows[0]?.user_version;
    if (typeof v === "number") {
      return v;
    }
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function assertTemplateLayout(dbPath: string): Promise<void> {
  const ver = await readTemplateUserVersion(dbPath);
  if (ver !== GOLDEN_STORE_TEMPLATE_VERSION) {
    throw new Error(
      `Golden store template user_version mismatch: expected ${GOLDEN_STORE_TEMPLATE_VERSION}, got ${String(ver)}. Regenerate resources/golden-chat-store.template.db.`
    );
  }
  const blobsCols = await querySqliteRows(dbPath, "PRAGMA table_info(blobs);");
  const metaCols = await querySqliteRows(dbPath, "PRAGMA table_info(meta);");
  const blobHasData = blobsCols.some((c) => c.name === "data");
  const metaHasValue = metaCols.some((c) => c.name === "value");
  if (!blobHasData || !metaHasValue) {
    throw new Error(
      "Golden store template missing expected columns blobs(id,data) and meta(key,value). Regenerate resources/golden-chat-store.template.db."
    );
  }
}

function normalizedRole(role: string): "user" | "assistant" | "tool" {
  return role === "assistant" || role === "tool" ? role : "user";
}

function buildMessageBlob(message: ChatMessageEntry): Buffer {
  const payload = {
    role: normalizedRole(message.role),
    content: [{ type: "text", text: message.content }],
  };
  return Buffer.from(JSON.stringify(payload), "utf-8");
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function buildTreeBlob(refHashesHex: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const hex of refHashesHex) {
    parts.push(Buffer.from([0x0a, 0x20]));
    parts.push(Buffer.from(hex, "hex"));
  }
  parts.push(Buffer.from([0x2a, 0x00]));
  return Buffer.concat(parts);
}

export function messagesFromChatBundle(bundle: BundleForStoreHydrate): ChatMessageEntry[] {
  const messages: ChatMessageEntry[] = [];
  for (const tf of bundle.transcriptFiles) {
    let text: string;
    try {
      text = decodeTranscriptArtifact(tf.content, tf.encoding).toString("utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const row = line.trim();
      if (!row) {
        continue;
      }
      try {
        const parsed = JSON.parse(row) as {
          role?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        const role =
          parsed.role === "assistant" || parsed.role === "tool"
            ? parsed.role
            : "user";
        const parts = parsed.message?.content;
        let content = "";
        if (Array.isArray(parts)) {
          content = parts
            .filter((p) => p?.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
        }
        if (content.trim()) {
          messages.push({ role, content });
        }
      } catch {
        continue;
      }
    }
  }
  return messages;
}

function bundleCreatedAtMs(bundle: BundleForStoreHydrate): number {
  const parsed = Date.parse(String(bundle.createdAt).replace("Z", "+00:00"));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export function chatManifestFromBundle(bundle: BundleForStoreHydrate): ChatsManifestChat {
  const content = messagesFromChatBundle(bundle);
  return {
    chat_id: bundle.conversationId,
    title: bundle.title?.trim() || bundle.conversationId,
    content: content.length > 0 ? content : [{ role: "user", content: bundle.previewText || bundle.title }],
    timestamp: bundleCreatedAtMs(bundle),
  };
}

export async function hydrateGoldenStoreTemplate(options: {
  templatePath: string;
  outputPath: string;
  chat: ChatsManifestChat;
}): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  await assertTemplateLayout(options.templatePath);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.copyFile(options.templatePath, options.outputPath);

  const messages: ChatMessageEntry[] =
    options.chat.content.length > 0
      ? options.chat.content
      : [{ role: "user", content: options.chat.title }];

  const messageBlobs = messages.map(buildMessageBlob);
  const messageHashes = messageBlobs.map(sha256Hex);
  const treeBlob = buildTreeBlob(messageHashes);
  const treeHash = sha256Hex(treeBlob);

  const metaObj = {
    agentId: options.chat.chat_id,
    latestRootBlobId: treeHash,
    name: options.chat.title,
    mode: "default",
    isRunEverything: true,
    createdAt: getChatTimestampMs(options.chat),
  };
  const metaJson = JSON.stringify(metaObj);

  const inserts: string[] = [];
  inserts.push(
    `INSERT INTO meta(key, value) VALUES ('0', '${escapeSqlLiteral(metaJson)}');`
  );
  const seen = new Set<string>();
  for (let i = 0; i < messageBlobs.length; i++) {
    const id = messageHashes[i];
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    inserts.push(
      `INSERT INTO blobs(id, data) VALUES ('${id}', X'${messageBlobs[i].toString("hex")}');`
    );
  }
  if (!seen.has(treeHash)) {
    inserts.push(
      `INSERT INTO blobs(id, data) VALUES ('${treeHash}', X'${treeBlob.toString("hex")}');`
    );
  }

  const script = `BEGIN IMMEDIATE;\n${inserts.join("\n")}\nCOMMIT;\n`;

  await runSqliteScript(options.outputPath, script);
  warnings.push(
    "Golden template hydration is best-effort; Cursor upgrades may change store.db layout. See docs/transcript-fidelity-matrix.md."
  );
  return { warnings };
}
