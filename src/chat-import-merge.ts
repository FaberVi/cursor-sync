import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatBundle } from "./chat-persistence.js";
import { escapeSqlLiteral } from "./composer-merge.js";
import {
  listGlobalStateVscdbPaths,
  querySqliteRows,
  resolveStateDbCandidates,
  runSqliteScript,
} from "./transcripts-sqlite.js";
import {
  prepareHeadersForImport,
  type WorkspaceIdentifier,
} from "./chat-composer-headers.js";
import { prepareComposerDataForImport } from "./chat-composer-data.js";

export type { WorkspaceIdentifier, PrepareHeadersOptions } from "./chat-composer-headers.js";
export {
  filterComposerHeadersForConversation,
  headersPayloadForImport,
  pinComposerAsMostRecent,
  rebindComposerRecord,
  stampWorkspaceIdentifierOnHeaders,
  prepareHeadersForImport,
} from "./chat-composer-headers.js";
export {
  filterComposerDataForConversation,
  composerDataForFocus,
  composerDataEntryIsRich,
  composerDataEntryHasConversationSignals,
  parseComposerDataKvJson,
  readRichComposerDataEntryFromStateDb,
  buildMinimalComposerDataForOpen,
  prepareComposerDataForImport,
  repairComposerDataAfterActivation,
} from "./chat-composer-data.js";

export interface MergeTargetsOptions {
  stateDbPath?: string | null;
  syncGlobal: boolean;
}

export interface SidebarMergeResult {
  merged: boolean;
  warnings: string[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @deprecated No longer called from restoreChatBundle; Python handles sidebar writes. Retained for tests only.
 */
export async function mergeTargetsForImport(
  stateDbPath: string | null | undefined,
  syncGlobal: boolean
): Promise<string[]> {
  const targets: string[] = [];
  const seen = new Set<string>();

  if (stateDbPath) {
    const resolved = path.resolve(stateDbPath);
    if (await fileExists(resolved)) {
      targets.push(resolved);
      seen.add(resolved);
    }
  }

  if (syncGlobal) {
    const globalDbs = await listGlobalStateVscdbPaths();
    for (const g of globalDbs) {
      const gp = path.resolve(g);
      if (!seen.has(gp)) {
        targets.push(gp);
        seen.add(gp);
        break;
      }
    }
  }

  if (targets.length === 0) {
    const candidates = await resolveStateDbCandidates();
    for (const c of candidates) {
      const cp = path.resolve(c);
      if (!seen.has(cp)) {
        targets.push(cp);
        seen.add(cp);
        break;
      }
    }
  }

  return targets;
}

export async function mergeSidebarIntoStateDb(
  dbPath: string,
  bundle: ChatBundle,
  workspaceIdentifier: WorkspaceIdentifier,
  options: { dryRun?: boolean; pinRecent?: boolean } = {}
): Promise<SidebarMergeResult> {
  const warnings: string[] = [];
  const dryRun = options.dryRun === true;
  const pinRecent = options.pinRecent !== false;

  const snap = bundle.sidebarSnapshot;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    warnings.push("No sidebarSnapshot in bundle; state merge skipped.");
    return { merged: false, warnings };
  }

  const cid = bundle.conversationId?.trim();
  if (!cid) {
    warnings.push("Bundle missing conversationId; state merge skipped.");
    return { merged: false, warnings };
  }

  const rows = await querySqliteRows(
    dbPath,
    "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');",
    { retries: 3 }
  );

  let existingHeadersRaw: string | undefined;
  let existingDataRaw: string | undefined;
  for (const row of rows) {
    const key = String(row.key ?? "");
    const value = row.value;
    if (key === "composer.composerHeaders") {
      existingHeadersRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
    if (key === "composer.composerData") {
      existingDataRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  const mergedHeaders = prepareHeadersForImport(
    existingHeadersRaw,
    bundle,
    cid,
    workspaceIdentifier,
    { pinRecent }
  );

  const mergedData = prepareComposerDataForImport(
    existingDataRaw,
    bundle,
    cid,
    workspaceIdentifier
  );
  const scriptParts: string[] = ["BEGIN IMMEDIATE;"];

  if (mergedHeaders.allComposers.length > 0) {
    const escaped = escapeSqlLiteral(JSON.stringify(mergedHeaders));
    scriptParts.push(
      `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerHeaders';`,
      `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');`
    );
  }

  const escapedData = escapeSqlLiteral(JSON.stringify(mergedData));
  scriptParts.push(
    `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';`,
    `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');`
  );

  scriptParts.push("COMMIT;");

  if (scriptParts.length <= 2) {
    warnings.push("Nothing to merge into state.vscdb.");
    return { merged: false, warnings };
  }

  if (dryRun) {
    return { merged: true, warnings };
  }

  await runSqliteScript(dbPath, scriptParts.join("\n") + "\n");
  return { merged: true, warnings };
}
