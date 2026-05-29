import * as crypto from "node:crypto";
import type { ChatBundle } from "./chat-persistence.js";
import { escapeSqlLiteral } from "./composer-merge.js";
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

export function isDiskKvKeyInConversationScope(key: string, conversationId: string): boolean {
  if (key === `composerData:${conversationId}`) {
    return true;
  }
  return key.startsWith(`bubbleId:${conversationId}:`);
}

/** Matches Python cursor_disk_kv_value_as_text (UTF-8 text or BLOB as hex from Python sqlite reader). */
export function cursorDiskKvValueAsText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (
    trimmed.length >= 4 &&
    trimmed.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(trimmed) &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[")
  ) {
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
    } catch {
      /* skip */
    }
  }
  return count;
}

function diskKvKeysSql(conversationId: string): string {
  const prefixBubble = escapeSqlLiteral(`bubbleId:${conversationId}:`);
  const keyComposer = escapeSqlLiteral(`composerData:${conversationId}`);
  return `SELECT key FROM cursorDiskKV WHERE key = '${keyComposer}' OR key LIKE '${prefixBubble}%';`;
}

/**
 * Export Layer 4 cursorDiskKV rows for a conversation from global state.vscdb.
 * Reads keys first, then each value separately — bulk SELECT key,value can fail with
 * "database disk image is malformed" on large live global state.vscdb under Cursor lock.
 */
export async function exportDiskKvSnapshot(
  globalDbPath: string,
  conversationId: string,
  opts?: { retries?: number }
): Promise<DiskKvSnapshot | null> {
  const keyRows = await querySqliteRows(globalDbPath, diskKvKeysSql(conversationId), opts);

  const rows: DiskKvSnapshotRow[] = [];
  for (const keyRow of keyRows) {
    const key = String(keyRow.key ?? "");
    if (!isDiskKvKeyInConversationScope(key, conversationId)) {
      continue;
    }
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

/**
 * When a bundle lacks diskKvSnapshot (schema v1), capture native Layer 4 from global
 * state.vscdb if the conversation still exists on this machine (re-import / re-export).
 */
export async function enrichBundleWithLiveDiskKv(
  bundle: ChatBundle,
  opts?: { retries?: number; extensionPath?: string }
): Promise<{ bundle: ChatBundle; warnings: string[] }> {
  const warnings: string[] = [];
  if (bundle.diskKvSnapshot?.rows?.length) {
    return { bundle, warnings };
  }
  const globalDbPaths = await listGlobalStateVscdbPaths();
  const globalDb = globalDbPaths[0];
  if (!globalDb) {
    return { bundle, warnings };
  }
  try {
    let enrichedViaPython = false;
    let snap = await exportDiskKvSnapshot(globalDb, bundle.conversationId, opts);
    if (!snap) {
      const onDisk = await countDiskKvBubblesOnGlobalDb(globalDb, bundle.conversationId);
      if (onDisk.bubbleCount > 0 && opts?.extensionPath) {
        const { runPythonExportDiskKvSnapshot } = await import("./chat-transport-scripts.js");
        const pySnap = await runPythonExportDiskKvSnapshot({
          conversationId: bundle.conversationId,
          globalDbPath: globalDb,
          extensionPath: opts.extensionPath,
        });
        if (pySnap) {
          snap = pySnap;
          enrichedViaPython = true;
          warnings.push(
            `Enriched bundle via Python diskKv export (${pySnap.rowCount} rows, ${pySnap.toolBubbleCount} tool/MCP bubbles).`
          );
        }
      }
    }
    if (!snap) {
      return { bundle, warnings };
    }
    if (!enrichedViaPython) {
      warnings.push(
        `Enriched bundle with live diskKvSnapshot (${snap.rowCount} rows, ${snap.toolBubbleCount} tool/MCP bubbles) from global state.vscdb.`
      );
    }
    return {
      bundle: {
        ...bundle,
        schemaVersion: 2,
        diskKvSnapshot: snap,
      },
      warnings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not enrich bundle from live diskKv: ${msg}`);
    return { bundle, warnings };
  }
}

export async function countDiskKvBubblesOnGlobalDb(
  globalDbPath: string,
  conversationId: string
): Promise<{ bubbleCount: number; hasComposerData: boolean }> {
  const rawRows = await querySqliteRows(globalDbPath, diskKvKeysSql(conversationId));
  let bubbleCount = 0;
  let hasComposerData = false;
  for (const raw of rawRows) {
    const key = String(raw.key ?? "");
    if (key === `composerData:${conversationId}`) {
      hasComposerData = true;
    } else if (key.startsWith(`bubbleId:${conversationId}:`)) {
      bubbleCount += 1;
    }
  }
  return { bubbleCount, hasComposerData };
}
