import * as crypto from "node:crypto";
import type { ChatBundle } from "./chat-persistence.js";
import { isDiskKvKeyInConversationScope } from "./chat-bundle-format.js";
import { escapeSqlLiteral } from "./composer-merge.js";
import { runPythonExportDiskKvSnapshot } from "./chat-transport-scripts.js";
import { listGlobalStateVscdbPaths, querySqliteRows } from "./transcripts-sqlite.js";

export interface DiskKvSnapshotRow {
  key: string;
  value: string;
  checksum: string;
}

export interface DiskKvSnapshot {
  sourceStateDbPath: string;
  rows: DiskKvSnapshotRow[];
  rowCount: number;
  toolBubbleCount: number;
}

export function cursorDiskKvValueAsText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (trimmed.length >= 4 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    try {
      return Buffer.from(trimmed, "hex").toString("utf-8");
    } catch {
      return null;
    }
  }
  return value;
}

function sha256HexUtf8(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function countToolBubbles(rows: Array<{ value: string }>): number {
  let count = 0;
  for (const row of rows) {
    try {
      const obj = JSON.parse(row.value) as Record<string, unknown>;
      if (obj.toolFormerData) {
        count += 1;
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) {
        throw e;
      }
    }
  }
  return count;
}

function diskKvKeysSql(conversationId: string): string {
  const prefixBubble = escapeSqlLiteral(`bubbleId:${conversationId}:`);
  const keyComposer = escapeSqlLiteral(`composerData:${conversationId}`);
  return `SELECT key FROM cursorDiskKV WHERE key = '${keyComposer}' OR key LIKE '${prefixBubble}%';`;
}

async function listDiskKvKeys(
  globalDbPath: string,
  conversationId: string,
  opts?: { retries?: number }
): Promise<string[]> {
  const keyRows = await querySqliteRows(globalDbPath, diskKvKeysSql(conversationId), opts);
  const keys: string[] = [];
  for (const keyRow of keyRows) {
    const key = String(keyRow.key ?? "");
    if (isDiskKvKeyInConversationScope(key, conversationId)) {
      keys.push(key);
    }
  }
  return keys;
}

export async function exportDiskKvSnapshot(
  globalDbPath: string,
  conversationId: string,
  opts?: { retries?: number }
): Promise<DiskKvSnapshot | null> {
  const rows: DiskKvSnapshotRow[] = [];
  for (const key of await listDiskKvKeys(globalDbPath, conversationId, opts)) {
    const escKey = escapeSqlLiteral(key);
    let valueRows: Array<Record<string, unknown>>;
    try {
      valueRows = await querySqliteRows(
        globalDbPath,
        `SELECT value FROM cursorDiskKV WHERE key = '${escKey}' LIMIT 1;`,
        opts
      );
    } catch {
      continue;
    }
    const text = cursorDiskKvValueAsText(valueRows[0]?.value);
    if (text === null) {
      continue;
    }
    rows.push({
      key,
      value: text,
      checksum: sha256HexUtf8(text),
    });
  }

  if (rows.length === 0) {
    return null;
  }
  return {
    sourceStateDbPath: globalDbPath,
    rows,
    rowCount: rows.length,
    toolBubbleCount: countToolBubbles(rows),
  };
}

export async function enrichBundleWithLiveDiskKv(
  bundle: ChatBundle,
  opts?: { retries?: number; extensionPath?: string }
): Promise<{ bundle: ChatBundle; warnings: string[] }> {
  const warnings: string[] = [];
  if (bundle.diskKvSnapshot?.rows?.length) {
    return { bundle, warnings };
  }
  const globalDb = (await listGlobalStateVscdbPaths())[0];
  if (!globalDb) {
    return { bundle, warnings };
  }
  try {
    let snap = await exportDiskKvSnapshot(globalDb, bundle.conversationId, opts);
    let via = "global state.vscdb";
    if (!snap) {
      const bubbleKeys = await countDiskKvBubbleKeys(globalDb, bundle.conversationId);
      if (bubbleKeys > 0 && opts?.extensionPath) {
        snap = await runPythonExportDiskKvSnapshot({
          conversationId: bundle.conversationId,
          globalDbPath: globalDb,
          extensionPath: opts.extensionPath,
        });
        via = "Python diskKv export";
      }
    }
    if (!snap) {
      return { bundle, warnings };
    }
    warnings.push(
      `Enriched bundle via ${via} (${snap.rowCount} rows, ${snap.toolBubbleCount} tool/MCP bubbles).`
    );
    return {
      bundle: { ...bundle, schemaVersion: 2, diskKvSnapshot: snap },
      warnings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not enrich bundle from live diskKv: ${msg}`);
    return { bundle, warnings };
  }
}

export async function countDiskKvBubbleKeys(
  globalDbPath: string,
  conversationId: string
): Promise<number> {
  const prefix = `bubbleId:${conversationId}:`;
  let count = 0;
  for (const key of await listDiskKvKeys(globalDbPath, conversationId)) {
    if (key.startsWith(prefix)) {
      count += 1;
    }
  }
  return count;
}
