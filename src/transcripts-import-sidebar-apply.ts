import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createBackup, rollbackFromBackup } from "./rollback.js";
import { getLogger } from "./diagnostics.js";
import {
  extractComposerHeadersPayload,
  extractComposerDataPayload,
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  mergeComposerDataAdditive,
  mergeComposerHeadersChain,
  escapeSqlLiteral,
} from "./composer-merge.js";
import {
  resolveImportMergeStateDbCandidates,
  runSqliteScript,
  querySqliteRows,
  isExecFileTimeoutError,
} from "./transcripts-sqlite.js";
import type {
  RestoreOperation,
  StateRestoreOutcome,
} from "./transcripts-internal-types.js";

const DELAYED_WRITEBACK_MS = 5_000;

export function stampWorkspaceIdentifierOnPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const list = Array.isArray(payload.allComposers) ? payload.allComposers : [];
  const needsStamp = list.some(
    (c) => c && typeof c === "object" && !Array.isArray(c) && !(c as Record<string, unknown>).workspaceIdentifier
  );
  if (!needsStamp) {
    return payload;
  }
  const wsId = buildCurrentWorkspaceIdentifier();
  if (!wsId) {
    return payload;
  }
  return {
    ...payload,
    allComposers: list.map((c) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        return c;
      }
      const rec = c as Record<string, unknown>;
      if (rec.workspaceIdentifier) {
        return rec;
      }
      return { ...rec, workspaceIdentifier: wsId };
    }),
  };
}

function buildCurrentWorkspaceIdentifier(): Record<string, unknown> | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const folder = folders[0]!;
  const fsPath = folder.uri.fsPath;
  return {
    id: crypto.createHash("md5").update(fsPath).digest("hex"),
    uri: {
      $mid: 1,
      fsPath,
      _sep: process.platform === "win32" ? 1 : 47,
      external: folder.uri.toString(),
      path: folder.uri.path,
      scheme: folder.uri.scheme,
    },
  };
}

async function resolveSidebarImportStateDbPaths(
  parsed: Record<string, unknown>
): Promise<{ paths: string[]; usedFallback: boolean }> {
  const sp = parsed.stateDbPath;
  if (typeof sp === "string" && sp.length > 0) {
    try {
      await fs.access(sp);
      return { paths: [sp], usedFallback: false };
    } catch {
      const candidates = await resolveImportMergeStateDbCandidates();
      if (candidates.length > 0) {
        return { paths: [candidates[0]!], usedFallback: true };
      }
      return { paths: [], usedFallback: false };
    }
  }
  const candidates = await resolveImportMergeStateDbCandidates();
  return { paths: candidates.length > 0 ? [candidates[0]!] : [], usedFallback: false };
}

export async function applySidebarStateRestoration(
  context: vscode.ExtensionContext,
  sidebarOps: RestoreOperation[],
  logger: ReturnType<typeof getLogger>,
  options?: { scheduleDelayedWriteback?: boolean }
): Promise<StateRestoreOutcome> {
  const outcome: StateRestoreOutcome = {
    stateDbMerged: 0,
    stateDbSkippedNoPayload: 0,
    stateDbSkippedNoDb: 0,
    statePartial: false,
    warnings: [],
  };

  type Agg = {
    headerPayloads: Array<Record<string, unknown>>;
    dataPayloads: Array<Record<string, unknown>>;
    conversationIds: string[];
  };
  const byDb = new Map<string, Agg>();

  for (const op of sidebarOps) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(op.content.toString("utf-8")) as Record<string, unknown>;
    } catch {
      outcome.warnings.push(`Sidebar ${op.conversationId ?? "?"}: invalid JSON; state.vscdb unchanged.`);
      outcome.statePartial = true;
      continue;
    }

    const headersPayload = extractComposerHeadersPayload(parsed);
    const effectiveHeadersPayload =
      headersPayload ?? deriveComposerHeadersPayloadFromSidebarSnapshot(parsed);
    const dataPayload = extractComposerDataPayload(parsed);
    if (!effectiveHeadersPayload && !dataPayload) {
      outcome.stateDbSkippedNoPayload += 1;
      continue;
    }

    const { paths, usedFallback } = await resolveSidebarImportStateDbPaths(parsed);
    if (paths.length === 0) {
      outcome.stateDbSkippedNoDb += 1;
      outcome.warnings.push(
        `Sidebar ${op.conversationId ?? "?"}: state.vscdb not found; only sidebar JSON was written.`
      );
      outcome.statePartial = true;
      continue;
    }

    if (typeof parsed.stateDbPath === "string" && parsed.stateDbPath.length > 0 && usedFallback) {
      outcome.warnings.push(
        `Sidebar ${op.conversationId ?? "?"}: exported stateDbPath unavailable; used default state.vscdb (partial).`
      );
      outcome.statePartial = true;
    }

    const dbPath = paths[0]!;
    const agg = byDb.get(dbPath) ?? {
      headerPayloads: [],
      dataPayloads: [],
      conversationIds: [],
    };
    if (effectiveHeadersPayload) {
      const stamped = stampWorkspaceIdentifierOnPayload(effectiveHeadersPayload);
      agg.headerPayloads.push(stamped);
    }
    if (dataPayload) {
      agg.dataPayloads.push(dataPayload);
    }
    if (op.conversationId) {
      agg.conversationIds.push(op.conversationId);
    }
    byDb.set(dbPath, agg);
  }

  const delayedWritebackTargets: Array<{
    dbPath: string;
    mergedHeadersJson: string;
    mergedDataJson: string | null;
    agg: Agg;
  }> = [];

  for (const [dbPath, agg] of byDb) {
    let existingHeadersRaw: string | undefined;
    let existingDataRaw: string | undefined;
    try {
      const rows = await querySqliteRows(
        dbPath,
        "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');"
      );
      for (const row of rows) {
        const key = String(row.key ?? "");
        const value = row.value;
        if (key === "composer.composerHeaders") {
          if (typeof value === "string") {
            existingHeadersRaw = value;
          } else if (value != null && typeof value === "object") {
            existingHeadersRaw = JSON.stringify(value);
          }
        }
        if (key === "composer.composerData") {
          if (typeof value === "string") {
            existingDataRaw = value;
          } else if (value != null && typeof value === "object") {
            existingDataRaw = JSON.stringify(value);
          }
        }
      }
    } catch (error) {
      outcome.warnings.push(
        isExecFileTimeoutError(error)
          ? `State DB ${dbPath}: SQLite timed out (database may be locked); merge skipped.`
          : `State DB ${dbPath}: read failed; merge skipped.`
      );
      outcome.statePartial = true;
      continue;
    }

    const mergedHeaders = mergeComposerHeadersChain(existingHeadersRaw, agg.headerPayloads);
    const mergedHeadersJson = JSON.stringify(mergedHeaders);
    const mergedData = mergeComposerDataAdditive(existingDataRaw, agg.dataPayloads);
    const mergedDataJson = JSON.stringify(mergedData);

    const { entries: backupEntries } = await createBackup(context, [dbPath]);
    try {
      const escapedHeaders = escapeSqlLiteral(mergedHeadersJson);
      const headerScript =
        `UPDATE ItemTable SET value = '${escapedHeaders}' WHERE key = 'composer.composerHeaders';\n` +
        `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escapedHeaders}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');\n`;
      const dataScript =
        agg.dataPayloads.length > 0
          ? (() => {
              const escapedData = escapeSqlLiteral(mergedDataJson);
              return (
                `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';\n` +
                `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');\n`
              );
            })()
          : "";
      const script = `BEGIN IMMEDIATE;\n${headerScript}${dataScript}COMMIT;\n`;
      await runSqliteScript(dbPath, script);
      outcome.stateDbMerged += 1;
      logger.appendLine(
        `[${new Date().toISOString()}] Merged composer state in ${dbPath} for ${agg.conversationIds.join(",")}`
      );

      if (options?.scheduleDelayedWriteback) {
        delayedWritebackTargets.push({
          dbPath,
          mergedHeadersJson,
          mergedDataJson: agg.dataPayloads.length > 0 ? mergedDataJson : null,
          agg,
        });
      }
    } catch (error) {
      await rollbackFromBackup(backupEntries);
      outcome.warnings.push(
        `State DB ${dbPath}: write failed (${error instanceof Error ? error.message : String(error)}); rolled back.`
      );
      outcome.statePartial = true;
    }
  }

  if (delayedWritebackTargets.length > 0) {
    const targets = delayedWritebackTargets;
    let completed = false;
    let resolveCompletion: (() => void) | undefined;

    const runWriteback = async () => {
      for (const target of targets) {
        try {
          const escapedHeaders = escapeSqlLiteral(target.mergedHeadersJson);
          const headerScript =
            `UPDATE ItemTable SET value = '${escapedHeaders}' WHERE key = 'composer.composerHeaders';\n` +
            `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escapedHeaders}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');\n`;
          const dataScript = target.mergedDataJson
            ? (() => {
                const escapedData = escapeSqlLiteral(target.mergedDataJson!);
                return (
                  `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';\n` +
                  `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');\n`
                );
              })()
            : "";
          const script = `BEGIN IMMEDIATE;\n${headerScript}${dataScript}COMMIT;\n`;
          await runSqliteScript(target.dbPath, script);
          logger.appendLine(
            `[${new Date().toISOString()}] Delayed write-back succeeded for ${target.dbPath} (${target.agg.conversationIds.join(",")})`
          );
        } catch (error) {
          logger.appendLine(
            `[${new Date().toISOString()}] Delayed write-back failed for ${target.dbPath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };

    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const timer = setTimeout(async () => {
      if (!completed) {
        completed = true;
        await runWriteback();
        resolveCompletion?.();
      }
    }, DELAYED_WRITEBACK_MS);

    outcome.delayedWriteback = {
      timer,
      cancel: () => {
        completed = true;
        clearTimeout(timer);
        resolveCompletion?.();
      },
      complete: async () => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          await runWriteback();
        }
        await completionPromise;
      },
    };
  }

  return outcome;
}
