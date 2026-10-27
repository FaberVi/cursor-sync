import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatBundle } from "./chat-persistence.js";
import { runPythonDiskImport } from "./chat-transport-scripts.js";
import { resolveSyncRoots } from "./paths.js";
import { getLogger } from "./diagnostics.js";
import { escapeSqlLiteral } from "./composer-merge.js";
import { querySqliteRows } from "./transcripts-sqlite.js";
import {
  stateDbPathForWorkspaceStorageId,
  type WorkspaceContext,
} from "./chat-workspace-context.js";

export async function globalCursorDiskKvHasComposer(
  conversationId: string
): Promise<boolean> {
  const globalDb = path.join(resolveSyncRoots().cursorUser, "globalStorage", "state.vscdb");
  try {
    const keyLit = escapeSqlLiteral(`composerData:${conversationId}`);
    const rows = await querySqliteRows(
      globalDb,
      `SELECT 1 AS ok FROM cursorDiskKV WHERE key = '${keyLit}' LIMIT 1;`,
      { retries: 1 }
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function syncDiskLayersForOpen(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  wsCtx: WorkspaceContext
): Promise<boolean> {
  const tmpPath = path.join(
    os.tmpdir(),
    `cursor-sync-open-${bundle.conversationId}-${Date.now()}.json`
  );
  await fs.writeFile(tmpPath, JSON.stringify(bundle, null, 2), "utf8");
  const stateDb = stateDbPathForWorkspaceStorageId(wsCtx.workspaceStorageId);
  const outcome = await runPythonDiskImport({
    bundlePath: tmpPath,
    workspaceFolder: wsCtx.folderFsPath,
    stateDbPath: stateDb,
    extensionPath: context.extensionPath,
    syncGlobal: true,
    pinRecent: true,
    log: (message) => getLogger().appendLine(message),
  });
  await fs.unlink(tmpPath).catch(() => {});
  return outcome.ok;
}
