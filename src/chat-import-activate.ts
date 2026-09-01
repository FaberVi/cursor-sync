import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatBundle } from "./chat-persistence.js";
import {
  applyRichComposerEntryToPartialState,
  partialStateForCreateNewCommand,
  partialStateHasConversationContent,
  partialStateSafeForCreateNew,
  type PartialState,
} from "./chat-partial-state.js";
import {
  readRichComposerDataEntryFromStateDb,
  repairComposerDataAfterActivation,
} from "./chat-import-merge.js";
import { repairDiskKvAfterActivation } from "./chat-disk-kv-import.js";
import { hydratePartialStateFromBundleDiskKv } from "./native-chat-json/hydrate.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { stateDbPathForWorkspaceStorageId } from "./chat-workspace-context.js";
import { resolveSyncRoots } from "./paths.js";
import {
  COMPOSER_GET_HANDLE_COMMAND_ID,
  buildActivationManifest,
  clearStaleResult,
  defaultActivationPaths,
  normalizeActivationManifest,
  parseComposerIdFromCommandResult,
  pendingManifestMatches,
  stagePendingManifest,
  waitForActivationResult,
  writeResultJson,
  type ActivationManifest,
  type ComposerActivationOutcome,
  type RunComposerActivationOptions,
  type RunPostImportActivationOptions,
} from "./chat-activation-manifest.js";
import {
  composerCommandAvailable,
  tryActivateViaComposerHandle,
  tryRegisterViaCreateNew,
} from "./chat-activation-composer.js";
import { runPythonComposerBridge } from "./chat-activation-bridge.js";

export {
  CREATE_NEW_COMPOSER_COMMAND_ID,
  CREATE_COMPOSER_COMMAND_ID,
  COMPOSER_GET_HANDLE_COMMAND_ID,
  OPEN_COMPOSER_COMMAND_ID,
  FOCUS_COMPOSER_COMMAND_ID,
  COMPOSER_URI_SCHEME,
  MANIFEST_VERSION,
  ACTIVATION_DIR,
  ACTIVATION_PENDING_PATH,
  ACTIVATION_RESULT_PATH,
  defaultActivationPaths,
  utcNowIso,
  buildActivationManifest,
  normalizeActivationManifest,
  stagePendingManifest,
  writeResultJson,
  clearStaleResult,
  parseComposerIdFromCommandResult,
  pendingManifestMatches,
  archiveFailedPending,
  readActivationResult,
  delayMs,
  waitForActivationResult,
} from "./chat-activation-manifest.js";
export type {
  ActivationPaths,
  ActivationResult,
  ComposerActivationOutcome,
  RunComposerActivationOptions,
  RunPythonComposerBridgeOptions,
  RunPostImportActivationOptions,
  WaitForActivationResultOptions,
  RawActivationManifest,
  ActivationManifest,
} from "./chat-activation-manifest.js";

export {
  buildOpenComposerCommandOptions,
  openExistingComposerInNewTab,
  composerCommandAvailable,
  composerUriForId,
  waitForComposerHandle,
  tryActivateViaComposerHandle,
} from "./chat-activation-composer.js";
export type { OpenComposerCommandOptions } from "./chat-activation-composer.js";

export {
  pingServerProbe,
  resolveComposerBridgeScript,
  parseBridgeStdout,
  runPythonComposerBridge,
} from "./chat-activation-bridge.js";

export async function enrichManifestPartialStateFromDisk(
  manifest: ActivationManifest,
  workspaceStorageId: string
): Promise<boolean> {
  const partial = manifest.partialState as Record<string, unknown>;
  if (partialStateHasConversationContent(partial)) {
    return false;
  }
  const { cursorUser } = resolveSyncRoots();
  const dbPaths = [
    stateDbPathForWorkspaceStorageId(workspaceStorageId),
    path.join(cursorUser, "globalStorage", "state.vscdb"),
  ];
  for (const dbPath of dbPaths) {
    const rich = await readRichComposerDataEntryFromStateDb(dbPath, manifest.composerId);
    if (!rich) {
      continue;
    }
    const targetWorkspaceIdentifier = partial.workspaceIdentifier;
    const targetName = partial.name;
    const nowMs = Date.now();
    applyRichComposerEntryToPartialState(
      partial as PartialState,
      rich,
      manifest.composerId
    );
    if (
      targetWorkspaceIdentifier &&
      typeof targetWorkspaceIdentifier === "object" &&
      !Array.isArray(targetWorkspaceIdentifier)
    ) {
      partial.workspaceIdentifier = targetWorkspaceIdentifier;
    }
    if (typeof targetName === "string" && targetName.trim()) {
      partial.name = targetName;
    }
    partial.createdAt = nowMs;
    partial.lastUpdatedAt = nowMs;
    partial.lastOpenedAt = nowMs;
    partial.conversationCheckpointLastUpdatedAt = nowMs;
    const headers = partial.fullConversationHeadersOnly;
    if (Array.isArray(headers)) {
      partial.fullConversationHeadersOnly = headers.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return entry;
        }
        const rec = entry as Record<string, unknown>;
        if (rec.composerId !== manifest.composerId) {
          return entry;
        }
        return {
          ...rec,
          workspaceIdentifier: partial.workspaceIdentifier,
          createdAt: nowMs,
          lastUpdatedAt: nowMs,
          lastOpenedAt: nowMs,
          conversationCheckpointLastUpdatedAt: nowMs,
        };
      });
    }
    return true;
  }
  return false;
}

export async function runPostImportActivation(
  bundle: ChatBundle | Record<string, unknown>,
  conversationId: string,
  workspaceCtx: WorkspaceContext,
  options: RunPostImportActivationOptions = {}
): Promise<ComposerActivationOutcome> {
  const log = options.log ?? (() => {});
  const paths = options.paths ?? defaultActivationPaths();
  const raw = buildActivationManifest(bundle, conversationId, workspaceCtx, {
    openInNewTab: options.openInNewTab,
  });
  const manifest = normalizeActivationManifest(
    raw as unknown as Record<string, unknown>
  );
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  const useProtobuf = cfg.get<boolean>("chatImport.useProtobufHydration") ?? true;
  const useIde = cfg.get<boolean>("chatImport.useIdeHydration") ?? false;
  const strictDiskGates = cfg.get<boolean>("chatImport.strictDiskGates") ?? false;

  if (useProtobuf && !useIde) {
    const partial = manifest.partialState as PartialState;
    if (
      hydratePartialStateFromBundleDiskKv(
        partial,
        bundle as ChatBundle,
        conversationId
      )
    ) {
      log("Hydrated partialState from bundle diskKv (protobuf path).");
    }
  }

  await enrichManifestPartialStateFromDisk(manifest, workspaceCtx.workspaceStorageId);

  if (strictDiskGates && !partialStateHasConversationContent(manifest.partialState)) {
    throw new Error(
      "strictDiskGates: partialState has no conversation content after hydration."
    );
  }

  log(`Activating composer ${conversationId}...`);

  const activationOutcome = await runComposerActivation(manifest, {
    paths,
    waitResultMs: options.bridgeWaitResultMs,
    log,
  });

  if (activationOutcome.ok) {
    const partial = manifest.partialState as Record<string, unknown>;
    const dbPath = stateDbPathForWorkspaceStorageId(workspaceCtx.workspaceStorageId);
    await repairComposerDataAfterActivation(dbPath, conversationId, partial);
    const { cursorUser } = resolveSyncRoots();
    const globalDb = path.join(cursorUser, "globalStorage", "state.vscdb");
    await repairComposerDataAfterActivation(globalDb, conversationId, partial);
    const diskKvRepairWorkspace = await repairDiskKvAfterActivation(
      dbPath,
      conversationId,
      bundle
    );
    const diskKvRepairGlobal = await repairDiskKvAfterActivation(
      globalDb,
      conversationId,
      bundle
    );
    if (diskKvRepairWorkspace.repaired || diskKvRepairGlobal.repaired) {
      log(
        `Re-persisted diskKv after activation (workspace=${diskKvRepairWorkspace.rowCount}, global=${diskKvRepairGlobal.rowCount} rows).`
      );
    }
    return activationOutcome;
  }

  if (!activationOutcome.stagedOnly) {
    return activationOutcome;
  }

  if (options.skipPythonBridge === true) {
    log(
      `Activation staged only: ${paths.pendingPath}. ` +
        "Cursor Sync will complete via composer.createComposer (reload window if needed)."
    );
    return activationOutcome;
  }

  log(
    `command ${manifest.commandId} unavailable; falling back to python bridge`
  );
  const bridgeOutcome = await runPythonComposerBridge(raw, {
    paths,
    waitResultMs: options.bridgeWaitResultMs,
    dryRun: options.dryRun,
    extensionPath: options.extensionPath,
    log,
  });

  if (options.activateStrict && bridgeOutcome.stagedOnly) {
    throw new Error(
      "Activation staged only (--activate-strict requires confirmed activation)"
    );
  }

  return bridgeOutcome;
}

export async function runComposerActivation(
  manifest: ActivationManifest,
  options: RunComposerActivationOptions = {}
): Promise<ComposerActivationOutcome> {
  const paths = options.paths ?? defaultActivationPaths();
  const log = options.log ?? (() => {});

  await clearStaleResult(paths);
  const stagePending = options.stagePending !== false;
  if (stagePending && !(await pendingManifestMatches(manifest, paths))) {
    await stagePendingManifest(manifest, paths);
  }

  const createAvailable = await composerCommandAvailable(manifest.commandId);

  const partial = manifest.partialState as Record<string, unknown>;
  const createNewOutcome = partialStateSafeForCreateNew(partial)
    ? await tryRegisterViaCreateNew(manifest, paths, log)
    : null;
  if (createNewOutcome && !createNewOutcome.ok) {
    log(
      `composer.createNew failed (exit ${createNewOutcome.exitCode}); ` +
        `falling back to ${manifest.commandId}`
    );
  } else if (createNewOutcome?.ok) {
    const openOutcome = await tryActivateViaComposerHandle(manifest, {
      ...options,
      acceptOpenWithoutHandle: options.acceptOpenWithoutHandle ?? true,
    });
    if (openOutcome?.ok) {
      return openOutcome;
    }
    return createNewOutcome;
  }

  if (createAvailable && partialStateSafeForCreateNew(partial)) {
    try {
      const commandResult = await vscode.commands.executeCommand(
        manifest.commandId,
        partialStateForCreateNewCommand(partial),
        manifest.createComposerOptions
      );
      const composerId = parseComposerIdFromCommandResult(
        commandResult,
        manifest.composerId
      );
      await writeResultJson(composerId, true, paths);
      log(`Activation OK: composerId=${composerId}`);
      return {
        ok: true,
        composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`composer.createComposer failed: ${message}`);
      return {
        ok: false,
        exitCode: 1,
        stagedOnly: false,
      };
    }
  }

  const handleOutcome = await tryActivateViaComposerHandle(manifest, options);
  if (handleOutcome?.ok) {
    return handleOutcome;
  }

  log(
    `IDE activation not available: command ${manifest.commandId} is not registered ` +
      `(fallback ${COMPOSER_GET_HANDLE_COMMAND_ID} also failed or unavailable).`
  );
  log(`Staged manifest: ${paths.pendingPath}`);

  const waitResultMs = Math.max(0, options.waitResultMs ?? 0);
  if (waitResultMs > 0) {
    const polled = await waitForActivationResult({
      paths,
      timeoutMs: waitResultMs,
    });
    if (polled) {
      return {
        ok: true,
        composerId: polled,
        exitCode: 0,
        stagedOnly: false,
      };
    }
  }

  return {
    ok: false,
    composerId: manifest.composerId,
    exitCode: 2,
    stagedOnly: true,
  };
}
