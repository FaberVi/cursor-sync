import type { ChatBundle } from "../chat-persistence.js";
import {
  mergeSidebarIntoStateDb,
  type WorkspaceIdentifier as MergeWorkspaceIdentifier,
} from "../chat-import-merge.js";
import type { WorkspaceContext } from "../chat-workspace-context.js";
import { stateDbPathForWorkspaceStorageId } from "../chat-workspace-context.js";
import { resolveSyncRoots } from "../paths.js";
import * as path from "node:path";

export interface SyncImportedComposerSidebarResult {
  workspaceMerged: boolean;
  globalMerged: boolean;
  warnings: string[];
}

/**
 * Merge imported composer headers into workspace + global state.vscdb (Layer 3).
 */
export async function syncImportedComposerSidebar(
  bundle: ChatBundle,
  workspaceCtx: WorkspaceContext,
  options: { dryRun?: boolean; pinRecent?: boolean } = {}
): Promise<SyncImportedComposerSidebarResult> {
  const workspaceIdentifier =
    workspaceCtx.workspaceIdentifier as unknown as MergeWorkspaceIdentifier;
  const workspaceDb = stateDbPathForWorkspaceStorageId(workspaceCtx.workspaceStorageId);
  const globalDb = path.join(resolveSyncRoots().cursorUser, "globalStorage", "state.vscdb");

  const workspaceResult = await mergeSidebarIntoStateDb(
    workspaceDb,
    bundle,
    workspaceIdentifier,
    options
  );
  const globalResult = await mergeSidebarIntoStateDb(
    globalDb,
    bundle,
    workspaceIdentifier,
    options
  );

  return {
    workspaceMerged: workspaceResult.merged,
    globalMerged: globalResult.merged,
    warnings: [...workspaceResult.warnings, ...globalResult.warnings],
  };
}
