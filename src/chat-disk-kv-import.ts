import type { ChatBundle } from "./chat-persistence.js";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
import { runSqliteScript } from "./transcripts-sqlite.js";

function isDiskKvKeyInConversationScope(key: string, conversationId: string): boolean {
  if (key === `composerData:${conversationId}`) {
    return true;
  }
  return key.startsWith(`bubbleId:${conversationId}:`);
}

/**
 * Re-persist Layer 4 cursorDiskKV rows after IDE activation may have clobbered them.
 */
export async function repairDiskKvAfterActivation(
  dbPath: string,
  conversationId: string,
  bundle: ChatBundle | Record<string, unknown>
): Promise<{ repaired: boolean; rowCount: number }> {
  const snap = (bundle as ChatBundle).diskKvSnapshot;
  if (!snap || !Array.isArray(snap.rows) || snap.rows.length === 0) {
    return { repaired: false, rowCount: 0 };
  }

  const scriptParts = ["BEGIN IMMEDIATE;"];
  let rowCount = 0;
  for (const row of snap.rows) {
    if (!row?.key || typeof row.value !== "string") {
      continue;
    }
    if (!isDiskKvKeyInConversationScope(row.key, conversationId)) {
      continue;
    }
    const keyLit = escapeSqlLiteral(row.key);
    const valLit = escapeSqlLiteral(row.value);
    scriptParts.push(
      `INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES ('${keyLit}', '${valLit}');`
    );
    rowCount += 1;
  }
  scriptParts.push("COMMIT;");

  if (rowCount === 0) {
    return { repaired: false, rowCount: 0 };
  }

  await runSqliteScript(dbPath, scriptParts.join("\n"));
  return { repaired: true, rowCount };
}
