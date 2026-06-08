import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatBundle } from "./chat-persistence.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { stateDbPathForWorkspaceStorageId } from "./chat-workspace-context.js";
import {
  mergeSidebarIntoStateDb,
  repairComposerDataAfterActivation,
  type WorkspaceIdentifier as MergeWorkspaceIdentifier,
} from "./chat-import-merge.js";
import {
  buildActivationManifest,
  enrichManifestPartialStateFromDisk,
  normalizeActivationManifest,
  runComposerActivation,
} from "./chat-import-activate.js";
import { getLogger } from "./diagnostics.js";
import { resolveSyncRoots } from "./paths.js";
import { requireWorkspaceContext } from "./chat-workspace-context.js";

const STORAGE_KEY = "cursorSync.pendingSidebarWriteback";
const PENDING_DIR = path.join(os.homedir(), ".cursor", "import-activation", "sidebar-pending");
const COMPOSER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolvePendingBundlePath(bundlePath: string): string | null {
  const resolved = path.resolve(bundlePath);
  const pendingRoot = path.resolve(PENDING_DIR);
  if (resolved === pendingRoot || !resolved.startsWith(`${pendingRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}

interface PendingSidebarWritebackEntry {
  conversationId: string;
  bundlePath: string;
  folderFsPath: string;
  workspaceStorageId: string;
  workspaceIdentifier: WorkspaceContext["workspaceIdentifier"];
  activate?: boolean;
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
    const { merged } = await mergeSidebarIntoStateDb(dbPath, bundle, wi, {
      pinRecent: true,
    });
    if (label === "workspace") {
      mergedWorkspace = merged;
    } else {
      mergedGlobal = merged;
    }
  }
  return { mergedWorkspace, mergedGlobal };
}

export async function queueSidebarWriteback(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  wsCtx: WorkspaceContext,
  options?: { activate?: boolean }
): Promise<void> {
  const conversationId = bundle.conversationId?.trim();
  if (!conversationId || !COMPOSER_ID_RE.test(conversationId) || !bundle.sidebarSnapshot) {
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
    activate: options?.activate === true,
  };

  if (context.globalState) {
    const existing = context.globalState.get<PendingSidebarWriteback>(STORAGE_KEY);
    const entries = (existing?.entries ?? []).filter((e) => e.conversationId !== conversationId);
    entries.push(entry);
    await context.globalState.update(STORAGE_KEY, {
      entries,
      queuedAt: new Date().toISOString(),
    });
  }
}

export async function flushPendingSidebarWriteback(
  context: vscode.ExtensionContext
): Promise<boolean> {
  if (!context.globalState) {
    return false;
  }
  const pending = context.globalState.get<PendingSidebarWriteback>(STORAGE_KEY);
  if (!pending?.entries.length) {
    return false;
  }
  const logger = getLogger();
  let applied = false;
  const remainingEntries: PendingSidebarWritebackEntry[] = [];

  for (const entry of pending.entries) {
    const safeBundlePath = resolvePendingBundlePath(entry.bundlePath);
    if (!safeBundlePath || !COMPOSER_ID_RE.test(entry.conversationId)) {
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-restore-debug] sidebar write-back skipped (invalid pending entry): conversationId=${entry.conversationId}`
      );
      continue;
    }

    let bundle: ChatBundle;
    try {
      const raw = await fs.readFile(safeBundlePath, "utf8");
      bundle = JSON.parse(raw) as ChatBundle;
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-restore-debug] sidebar write-back skipped (bundle read): ${err instanceof Error ? err.message : String(err)}`
      );
      remainingEntries.push(entry);
      continue;
    }

    const dbPaths = [
      stateDbPathForWorkspaceStorageId(entry.workspaceStorageId),
      globalStateDbPath(),
    ];

    let mergeSucceeded = false;
    for (const dbPath of dbPaths) {
      try {
        const wi = entry.workspaceIdentifier as unknown as MergeWorkspaceIdentifier;
        const { merged, warnings } = await mergeSidebarIntoStateDb(dbPath, bundle, wi, {
          pinRecent: true,
        });
        if (merged) {
          mergeSucceeded = true;
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

    if (!mergeSucceeded) {
      remainingEntries.push(entry);
      continue;
    }

    const shouldActivate = entry.activate === true;
    if (shouldActivate) {
      let activationOk = false;
      try {
        const wsCtx = await requireWorkspaceContext({ workspaceFolder: entry.folderFsPath });
        const manifest = normalizeActivationManifest(
          buildActivationManifest(bundle, entry.conversationId, wsCtx, {
            openInNewTab: true,
          }) as unknown as Record<string, unknown>
        );
        await enrichManifestPartialStateFromDisk(manifest, entry.workspaceStorageId);
        const activation = await runComposerActivation(manifest, {
          stagePending: false,
          acceptOpenWithoutHandle: false,
          log: (line) =>
            logger.appendLine(`[${new Date().toISOString()}] [chat-restore-debug] ${line}`),
        });
        activationOk = activation.ok;
        if (activation.ok) {
          const dbPath = stateDbPathForWorkspaceStorageId(entry.workspaceStorageId);
          await repairComposerDataAfterActivation(dbPath, entry.conversationId, manifest.partialState as Record<string, unknown>);
          const { cursorUser } = resolveSyncRoots();
          const globalDb = path.join(cursorUser, "globalStorage", "state.vscdb");
          await repairComposerDataAfterActivation(globalDb, entry.conversationId, manifest.partialState as Record<string, unknown>);
          applied = true;
        }
      } catch (err) {
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-restore-debug] sidebar activation failed conversationId=${entry.conversationId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!activationOk) {
        remainingEntries.push(entry);
        continue;
      }
    }

    try {
      await fs.unlink(safeBundlePath);
    } catch {}
  }

  if (remainingEntries.length > 0) {
    await context.globalState.update(STORAGE_KEY, {
      entries: remainingEntries,
      queuedAt: pending.queuedAt,
    });
  } else {
    await context.globalState.update(STORAGE_KEY, undefined);
  }
  return applied;
}
