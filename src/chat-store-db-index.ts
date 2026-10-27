import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { querySqliteRows } from "./transcripts-sqlite.js";

export interface StoreDbIndex {
  meta: Record<string, unknown>;
  blobCount: number;
  error?: string;
}

export function parseMetaValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 2 && trimmed.length % 2 === 0) {
      try {
        return JSON.parse(Buffer.from(trimmed, "hex").toString("utf8"));
      } catch {
        return value;
      }
    }
    return value;
  }
}

export function storeMetaRecord(storeIndex: StoreDbIndex): Record<string, unknown> | null {
  const raw = storeIndex.meta["0"] ?? storeIndex.meta[0];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

export async function decodeStoreDbIndex(
  storeBytes: Buffer | Uint8Array
): Promise<StoreDbIndex> {
  const out: StoreDbIndex = { meta: {}, blobCount: 0 };
  if (!storeBytes || storeBytes.length === 0) {
    return out;
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `cursor-sync-store-index-${process.pid}-${Date.now()}.db`
  );

  try {
    await fs.writeFile(tmpPath, storeBytes);
    const tables = await querySqliteRows(
      tmpPath,
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    const tableNames = new Set(
      tables
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string")
    );

    if (tableNames.has("meta")) {
      const metaRows = await querySqliteRows(tmpPath, "SELECT key, value FROM meta");
      const metaOut: Record<string, unknown> = {};
      for (const row of metaRows) {
        const key = row.key;
        if (typeof key === "string" || typeof key === "number") {
          metaOut[String(key)] = parseMetaValue(row.value);
        }
      }
      out.meta = metaOut;
    }

    if (tableNames.has("blobs")) {
      const countRows = await querySqliteRows(
        tmpPath,
        "SELECT COUNT(*) AS c FROM blobs"
      );
      const c = countRows[0]?.c;
      out.blobCount =
        typeof c === "number"
          ? Math.trunc(c)
          : typeof c === "string"
            ? parseInt(c, 10) || 0
            : 0;
    }
  } catch {
    out.error = "unreadable";
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }

  return out;
}
