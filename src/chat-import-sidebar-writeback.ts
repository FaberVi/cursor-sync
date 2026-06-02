import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatBundle } from "./chat-persistence.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { stateDbPathForWorkspaceStorageId } from "./chat-workspace-context.js";
import {
  mergeSidebarIntoStateDb,
  type WorkspaceIdentifier as MergeWorkspaceIdentifier,
} from "./chat-import-merge.js";
import {
  buildActivationManifest,
  normalizeActivationManifest,
  runComposerActivation,
} from "./chat-import-activate.js";
import { getLogger } from "./diagnostics.js";
import { resolveSyncRoots } from "./paths.js";
import { requireWorkspaceContext } from "./chat-workspace-context.js";
import { agentDebugLog } from "./debug-session-log.js";

const STORAGE_KEY = "cursorSync.pendingSidebarWriteback";
const PENDING_DIR = path.join(os.homedir(), ".cursor", "import-activation", "sidebar-pending");

interface PendingSidebarWritebackEntry {
  conversationId: string;
  bundlePath: string;
  folderFsPath: string;
  workspaceStorageId: string;
  workspaceIdentifier: WorkspaceContext["workspaceIdentifier"];
}

interface PendingSidebarWriteback {
  entries: PendingSidebarWritebackEntry[];
  queuedAt: string;
}

function globalStateDbPath(): string {
  const { cursorUser } = resolveSyncRoots();
  return path.join(cursorUser, "globalStorage", "state.vscdb");
}

export async function applyImmediateSidebarWriteback(
  bundle: ChatBundle,
  wsCtx: WorkspaceContext
): Promise<{ mergedWorkspace: boolean; mergedGlobal: boolean }> {
  const conversationId = bundle.conversationId?.trim();
  if (!conversationId || !bundle.sidebarSnapshot) {
    agentDebugLog("B", "chat-import-sidebar-writeback.ts:immediate-skip", "immediate merge skipped", {
      conversationId: conversationId ?? null,
      hasSidebarSnapshot: !!bundle.sidebarSnapshot,
    });
    return { mergedWorkspace: false, mergedGlobal: false };
  }
  const wi = wsCtx.workspaceIdentifier as unknown as MergeWorkspaceIdentifier;
  const dbPaths = [
    { label: "workspace", path: stateDbPathForWorkspaceStorageId(wsCtx.workspaceStorageId) },
    { label: "global", path: globalStateDbPath() },
  ];
  let mergedWorkspace = false;
  let mergedGlobal = false;
  for (const { label, path: dbPath } of dbPaths) {
    const { merged, warnings } = await mergeSidebarIntoStateDb(dbPath, bundle, wi, {
      pinRecent: true,
    });
    if (label === "workspace") {
      mergedWorkspace = merged;
    } else {
      mergedGlobal = merged;
    }
    agentDebugLog("D", "chat-import-sidebar-writeback.ts:immediate-merge", "immediate sidebar merge", {
      conversationId,
      dbLabel: label,
      merged,
      warningCount: warnings.length,
    });
  }
  return { mergedWorkspace, mergedGlobal };
}

export async function queueSidebarWriteback(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  wsCtx: WorkspaceContext
): Promise<void> {
  const conversationId = bundle.conversationId?.trim();
  if (!conversationId || !bundle.sidebarSnapshot) {
    agentDebugLog("B", "chat-import-sidebar-writeback.ts:queue-skip", "writeback queue skipped", {
      conversationId: conversationId ?? null,
      hasSidebarSnapshot: !!bundle.sidebarSnapshot,
    });
    return;
  }
  await fs.mkdir(PENDING_DIR, { recursive: true });
  const bundlePath = path.join(PENDING_DIR, `${conversationId}.json`);
  await fs.writeFile(bundlePath, JSON.stringify(bundle), "utf8");

  const entry: PendingSidebarWritebackEntry = {
    conversationId,
    bundlePath,
    folderFsPath: wsCtx.folderFsPath,
    workspaceStorageId: wsCtx.workspaceStorageId,
    workspaceIdentifier: wsCtx.workspaceIdentifier,
  };

  let pendingCount = 1;
  if (context.globalState) {
    const existing = context.globalState.get<PendingSidebarWriteback>(STORAGE_KEY);
    const entries = (existing?.entries ?? []).filter((e) => e.conversationId !== conversationId);
    entries.push(entry);
    pendingCount = entries.length;
    await context.globalState.update(STORAGE_KEY, {
      entries,
      queuedAt: new Date().toISOString(),
    });
  }
  agentDebugLog("B", "chat-import-sidebar-writeback.ts:queue-ok", "writeback queued", {
    conversationId,
    workspaceStorageId: wsCtx.workspaceStorageId,
    pendingCount,
  });
}

export async function flushPendingSidebarWriteback(
  context: vscode.ExtensionContext
): Promise<boolean> {
  if (!context.globalState) {
    return false;
  }
  const pending = context.globalState.get<PendingSidebarWriteback>(STORAGE_KEY);
  if (!pending?.entries.length) {
    agentDebugLog("D", "chat-import-sidebar-writeback.ts:flush-empty", "no pending writeback", {});
    return false;
  }
  agentDebugLog("D", "chat-import-sidebar-writeback.ts:flush-start", "flush pending writeback", {
    pendingCount: pending.entries.length,
    conversationIds: pending.entries.map((e) => e.conversationId),
  });
  const logger = getLogger();
  let applied = false;

  for (const entry of pending.entries) {
    let bundle: ChatBundle;
    try {
      const raw = await fs.readFile(entry.bundlePath, "utf8");
      bundle = JSON.parse(raw) as ChatBundle;
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-restore-debug] sidebar write-back skipped (bundle read): ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    const dbPaths = [
      stateDbPathForWorkspaceStorageId(entry.workspaceStorageId),
      globalStateDbPath(),
    ];

    for (const dbPath of dbPaths) {
      try {
        const wi = entry.workspaceIdentifier as unknown as MergeWorkspaceIdentifier;
        const { merged, warnings } = await mergeSidebarIntoStateDb(dbPath, bundle, wi, {
          pinRecent: true,
        });
        if (merged) {
          applied = true;
          logger.appendLine(
            `[${new Date().toISOString()}] [chat-restore-debug] sidebar write-back merged db=${dbPath} conversationId=${entry.conversationId}`
          );
        }
        for (const w of warnings) {
          logger.appendLine(
            `[${new Date().toISOString()}] [chat-restore-debug] sidebar write-back warn db=${dbPath}: ${w}`
          );
        }
      } catch (err) {
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-restore-debug] sidebar write-back failed db=${dbPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    try {
      const wsCtx = await requireWorkspaceContext({ workspaceFolder: entry.folderFsPath });
      const manifest = normalizeActivationManifest(
        buildActivationManifest(bundle, entry.conversationId, wsCtx, {
          openInNewTab: true,
        }) as unknown as Record<string, unknown>
      );
      const activation = await runComposerActivation(manifest, {
        stagePending: false,
        log: (line) =>
          logger.appendLine(`[${new Date().toISOString()}] [chat-restore-debug] ${line}`),
      });
      agentDebugLog(
        "N",
        "chat-import-sidebar-writeback.ts:flush-activation",
        "createComposer after write-back",
        {
          conversationId: entry.conversationId,
          ok: activation.ok,
          stagedOnly: activation.stagedOnly,
        },
        "post-fix"
      );
      if (activation.ok) {
        applied = true;
      }
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-restore-debug] sidebar activation failed conversationId=${entry.conversationId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      await fs.unlink(entry.bundlePath);
    } catch {
      /* ignore */
    }
  }

  await context.globalState.update(STORAGE_KEY, undefined);

  agentDebugLog(
    "L",
    "chat-import-sidebar-writeback.ts:flush",
    "sidebar write-back flush done",
    {
      applied,
      conversationIds: pending.entries.map((e) => e.conversationId),
    },
    "post-fix"
  );

  return applied;
}
