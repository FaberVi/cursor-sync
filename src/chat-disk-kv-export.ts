import * as crypto from "node:crypto";
import type { ChatBundle } from "./chat-persistence.js";
import { isDiskKvKeyInConversationScope } from "./chat-bundle-format.js";
import { escapeSqlLiteral } from "./composer-merge.js";
import { runPythonExportDiskKvSnapshot } from "./chat-transport-scripts.js";
import {
  listGlobalStateVscdbPaths,
  querySqliteRows,
  SQLITE_RETRY_BACKOFF_MS,
} from "./transcripts-sqlite.js";

const DEFAULT_ENRICH_RETRIES = 5;
const RICH_CHAT_MIN_BUBBLE_ROWS = 3;

function isSqliteLockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /locked|busy|SQLITE_BUSY/i.test(msg);
}

function diskKvSnapshotRowCount(bundle: ChatBundle): number {
  const snap = bundle.diskKvSnapshot;
  if (!snap) {
    return 0;
  }
  return snap.rowCount ?? (Array.isArray(snap.rows) ? snap.rows.length : 0);
}

function warnIfRichChatMissingToolBubbles(
  rowCount: number,
  toolBubbleCount: number,
  warnings: string[]
): void {
  if (rowCount >= RICH_CHAT_MIN_BUBBLE_ROWS && toolBubbleCount === 0) {
    warnings.push(
      `diskKv has ${rowCount} rows but 0 tool/MCP bubbles; open the chat in Composer on this machine before export for full Layer 4 fidelity.`
    );
  }
}

function promoteSchemaV2WhenDiskKvPresent(bundle: ChatBundle): ChatBundle {
  if (bundle.schemaVersion === 2 || diskKvSnapshotRowCount(bundle) === 0) {
    return bundle;
  }
  return { ...bundle, schemaVersion: 2 };
}

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

/** Matches Python cursor_disk_kv_value_as_text (UTF-8 text or BLOB as hex from Python sqlite reader). */
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
async function exportDiskKvSnapshotWithRetry(
  globalDb: string,
  conversationId: string,
  opts?: { retries?: number; extensionPath?: string }
): Promise<DiskKvSnapshot | null> {
  const maxAttempts = Math.max(1, opts?.retries ?? DEFAULT_ENRICH_RETRIES);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await exportDiskKvSnapshot(globalDb, conversationId, { retries: 2 });
    } catch (err) {
      lastErr = err;
      if (!isSqliteLockedError(err) || attempt >= maxAttempts) {
        throw err;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, SQLITE_RETRY_BACKOFF_MS * attempt)
      );
    }
  }
  if (lastErr) {
    throw lastErr;
  }
  return null;
}

export async function enrichBundleWithLiveDiskKv(
  bundle: ChatBundle,
  opts?: { retries?: number; extensionPath?: string }
): Promise<{ bundle: ChatBundle; warnings: string[] }> {
  const warnings: string[] = [];
  if (bundle.diskKvSnapshot?.rows?.length) {
    const rowCount = diskKvSnapshotRowCount(bundle);
    const toolBubbleCount = bundle.diskKvSnapshot.toolBubbleCount ?? 0;
    warnIfRichChatMissingToolBubbles(rowCount, toolBubbleCount, warnings);
    return { bundle: promoteSchemaV2WhenDiskKvPresent(bundle), warnings };
  }
  const globalDbPaths = await listGlobalStateVscdbPaths();
  const globalDb = globalDbPaths[0];
  if (!globalDb) {
    return { bundle, warnings };
  }
  try {
    let enrichedViaPython = false;
    let snap = await exportDiskKvSnapshotWithRetry(globalDb, bundle.conversationId, opts);
    if (!snap) {
      const onDisk = await countDiskKvBubblesOnGlobalDb(globalDb, bundle.conversationId);
      if (onDisk.bubbleCount > 0 && opts?.extensionPath) {
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
    warnIfRichChatMissingToolBubbles(snap.rowCount, snap.toolBubbleCount, warnings);
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
    if (isSqliteLockedError(err)) {
      warnings.push(
        `Could not enrich bundle from live diskKv: global state.vscdb is locked (close other Cursor windows or retry). ${msg}`
      );
    } else {
      warnings.push(`Could not enrich bundle from live diskKv: ${msg}`);
    }
    return { bundle, warnings };
  }
}

export async function probeLocalDiskKv(
  conversationId: string,
  opts?: { retries?: number }
): Promise<{ rowCount: number; toolBubbleCount: number } | null> {
  const globalDbPaths = await listGlobalStateVscdbPaths();
  const globalDb = globalDbPaths[0];
  if (!globalDb) {
    return null;
  }
  try {
    const snap = await exportDiskKvSnapshot(globalDb, conversationId, opts);
    if (!snap || snap.rowCount === 0) {
      return null;
    }
    return {
      rowCount: snap.rowCount,
      toolBubbleCount: snap.toolBubbleCount,
    };
  } catch {
    return null;
  }
}

export async function countDiskKvBubblesOnGlobalDb(
  globalDbPath: string,
  conversationId: string
): Promise<{ bubbleCount: number }> {
  const rawRows = await querySqliteRows(globalDbPath, diskKvKeysSql(conversationId));
  let bubbleCount = 0;
  for (const raw of rawRows) {
    const key = String(raw.key ?? "");
    if (key.startsWith(`bubbleId:${conversationId}:`)) {
      bubbleCount += 1;
    }
  }
  return { bubbleCount };
}
