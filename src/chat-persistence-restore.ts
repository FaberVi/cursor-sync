import type * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pruneOldBackups } from "./rollback.js";
import { requireWorkspaceContext } from "./chat-workspace-context.js";
import { emitChatImportProgress } from "./chat-progress-events.js";
import { resolveSyncRoots } from "./paths.js";
import {
  pingServerProbe,
  runPostImportActivation,
} from "./chat-import-activate.js";
import {
  mergeFidelitySummaries,
  parsePythonInspectStdout,
  summarizeBundleFidelity,
} from "./chat-bundle-fidelity.js";
import { runPythonBundleInspect } from "./chat-transport-scripts.js";
import {
  formatVerifyCheckLine,
  formatVerifyReport,
  runDiskAndActivationVerify,
  verifyActivationChecks,
  verifyChecksAllOk,
  type VerifyCheck,
} from "./chat-import-verify.js";
import { pickImportWorkspaceFolder } from "./chat-import-ux.js";
import {
  createRestoreDestinationCache,
  isOpenWorkspaceFolder,
  resolveRestoreWorkspaceFolder,
} from "./chat-restore-destination.js";
import { parseChatBundleOrCollection } from "./chat-bundle-format.js";
import {
  fidelityFieldsForImportHistory,
  publishImportFidelitySummary,
} from "./sidebar/chats-tab-fidelity.js";
import { recordImport as recordImportEntry } from "./sidebar/import-history.js";
import type { ChatBundle, LoadChatResult, RestoreChatBundleOptions } from "./chat-persistence.js";
import {
  applyImmediateSidebarWriteback,
  queueSidebarWriteback,
} from "./chat-import-sidebar-writeback.js";
import {
  bundleArtifactsDebug,
  logChatRestoreDebug,
} from "./chat-restore-debug.js";
import { restoreChatBundleDisk } from "./chat-restore-disk.js";
import {
  promptForTargetProject,
  resolveRestoreProjectMapping,
} from "./chat-restore-mapping.js";

export {
  logChatRestoreDebug,
  composerPayloadDebug,
  bundleArtifactsDebug,
} from "./chat-restore-debug.js";
export { resolveProjectsRoot } from "./chat-restore-mapping.js";
export {
  ensurePythonReady,
  ensureNativeChatStoreDb,
} from "./chat-restore-disk.js";

function sidebarVisibleOnDiskFromVerify(checks: VerifyCheck[]): boolean {
  const globalHeaders = checks.find((c) => c.name === "global.composerHeaders");
  if (globalHeaders?.status === "OK") {
    return true;
  }
  const wsHeaders = checks.find((c) => c.name.startsWith("workspace.composerHeaders"));
  return wsHeaders?.status === "OK";
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function restoreChatBundle(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options: RestoreChatBundleOptions = {}
): Promise<LoadChatResult> {
  if (
    bundle.type !== "chat-persistence" ||
    (bundle.schemaVersion !== 1 && bundle.schemaVersion !== 2)
  ) {
    throw new Error("Invalid or unsupported chat bundle format.");
  }

  const warnings: string[] = [];
  const verifyChecks: VerifyCheck[] = [];
  const conversationId = bundle.conversationId;
  let transcriptsWritten = 0;
  let storeWritten = false;
  let sidebarMerged = false;

  logChatRestoreDebug(
    `restoreChatBundle start conversationId=${conversationId} ${bundleArtifactsDebug(bundle)}`
  );

  progress.report({ message: "Resolving workspace..." });
  const explicitFolder = options.workspaceFolder?.trim();
  const cache = options.destinationCache ?? createRestoreDestinationCache();
  const sourceTilde = (bundle.sourceFolderTilde ?? "").trim();
  const fromTilde = explicitFolder
    ? undefined
    : await resolveRestoreWorkspaceFolder(bundle, { cache });
  if (!explicitFolder && sourceTilde && !fromTilde) {
    throw new Error(
      `Could not resolve project folder for ${sourceTilde}. Select a local folder when prompted, or open that project.`
    );
  }
  const folderFsPath = explicitFolder || fromTilde || (await pickImportWorkspaceFolder());
  if (!folderFsPath) {
    throw new Error(
      "Open a workspace folder in Cursor before importing a chat bundle (required for ~/.cursor/chats/<md5(folder)> store.db path)."
    );
  }
  const destIsOpen = isOpenWorkspaceFolder(folderFsPath);
  const activate = destIsOpen && options.activate === true;
  const wsCtx = await requireWorkspaceContext({ workspaceFolder: folderFsPath });
  const storeWorkspaceKey = wsCtx.chatsWorkspaceKey;
  const dryRun = options.dryRun === true;
  const syncGlobal = options.syncGlobal !== false;
  const pinRecent = options.pinRecent !== false;
  logChatRestoreDebug(
    `workspace context folder=${wsCtx.folderFsPath} chatsKey=${storeWorkspaceKey} storageId=${wsCtx.workspaceStorageId} dryRun=${dryRun} activate=${activate} destIsOpen=${destIsOpen}`
  );

  const sourceProjectKeys = new Set<string>();
  for (const tf of bundle.transcriptFiles) {
    const segments = tf.relativePath.split("/");
    if (segments.length > 0) {
      sourceProjectKeys.add(segments[0]!);
    }
  }

  const projectMapping = await resolveRestoreProjectMapping(
    [...sourceProjectKeys].sort(),
    wsCtx.folderFsPath,
    bundle.transcriptFiles.length,
    progress
  );
  if (projectMapping === null) {
    logChatRestoreDebug(`restoreChatBundle cancelled project mapping conversationId=${conversationId}`);
    return {
      conversationId,
      transcriptsWritten: 0,
      storeWritten: false,
      storeWorkspaceKey,
      restoredFolder: folderFsPath,
      sourceFolderTilde: bundle.sourceFolderTilde,
      activated: false,
      sidebarMerged: false,
      warnings: ["Cancelled by user."],
    };
  }

  const workspaceStateDb = path.join(
    resolveSyncRoots().cursorUser,
    "workspaceStorage",
    wsCtx.workspaceStorageId,
    "state.vscdb"
  );

  progress.report({ message: "Restoring chat files..." });
  const disk = await restoreChatBundleDisk(context, bundle, wsCtx, {
    projectMapping,
    workspaceStateDb,
    dryRun,
    syncGlobal,
    pinRecent,
    storeWorkspaceKey,
  });
  warnings.push(...disk.warnings);
  transcriptsWritten = disk.transcriptsWritten;
  storeWritten = disk.storeWritten;
  sidebarMerged = disk.sidebarMerged;
  const workingBundle = disk.workingBundle;
  const remappedBundle = disk.remappedBundle;
  const extensionPath = disk.extensionPath;

  if (!dryRun) {
    progress.report({ message: "Verifying import..." });
    const diskChecks = await runDiskAndActivationVerify(conversationId, wsCtx, {
      bundle: workingBundle,
      postActivate: false,
    });
    verifyChecks.push(...diskChecks);
    for (const c of diskChecks) {
      logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
    }
    if (!verifyChecksAllOk(diskChecks)) {
      throw new Error(
        `Import verify failed (see verify lines above):\n${formatVerifyReport(diskChecks)}`
      );
    }

    const sidebarOnDisk = sidebarVisibleOnDiskFromVerify(diskChecks);
    if (
      !sidebarMerged &&
      sidebarOnDisk &&
      remappedBundle.sidebarSnapshot != null &&
      typeof remappedBundle.sidebarSnapshot === "object"
    ) {
      sidebarMerged = true;
    }

    if (sidebarMerged && remappedBundle.sidebarSnapshot) {
      await applyImmediateSidebarWriteback(remappedBundle, wsCtx);
      await queueSidebarWriteback(context, remappedBundle, wsCtx, {
        activate: activate,
      });
    }

    if (activate) {
      if (!storeWritten) {
        warnings.push(
          "Bundle has no store.db snapshot; IDE activation usually requires store.db at ~/.cursor/chats/<md5(workspace)>/<conversationId>/store.db. Re-export from a machine where that file exists."
        );
        logChatRestoreDebug(
          `activation warning conversationId=${conversationId} storeWritten=false (storeSnapshot absent or restore failed)`
        );
      }
      progress.report({ message: "Activating composer..." });
      emitChatImportProgress({ conversationId, phase: "B", step: "activation-start" });
      const activationOutcome = await runPostImportActivation(
        workingBundle,
        conversationId,
        wsCtx,
        {
          activateStrict: options.activateStrict,
          bridgeWaitResultMs: options.bridgeWaitResultMs,
          dryRun: false,
          extensionPath,
          skipPythonBridge: true,
          log: (line) => logChatRestoreDebug(line),
        }
      );
      emitChatImportProgress({
        conversationId,
        phase: "B",
        step: "activation-done",
        ok: activationOutcome.ok,
        detail: activationOutcome.stagedOnly ? "staged-only" : undefined,
      });
      if (
        options.activateStrict &&
        activationOutcome.stagedOnly &&
        !activationOutcome.ok
      ) {
        throw new Error(
          "Activation staged only (--activate-strict requires confirmed activation)"
        );
      }
      if (options.pingServer) {
        pingServerProbe(conversationId, (line) => logChatRestoreDebug(line));
      }
      progress.report({ message: "Verifying activation..." });
      const activationChecks = await verifyActivationChecks(conversationId);
      verifyChecks.push(...activationChecks);
      for (const c of activationChecks) {
        logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
      }
      if (!verifyChecksAllOk(activationChecks)) {
        throw new Error(
          `Activation verify failed:\n${formatVerifyReport(activationChecks)}`
        );
      }
      const fidelity = summarizeBundleFidelity(workingBundle);
      if (options.activateStrict && fidelity.toolBubbleCount > 0) {
        const layer4Checks = (
          await runDiskAndActivationVerify(conversationId, wsCtx, {
            bundle: workingBundle,
            strictLayer4: true,
          })
        ).filter((c) => c.name.startsWith("layer4."));
        verifyChecks.push(...layer4Checks);
        for (const c of layer4Checks) {
          logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
        }
        if (!verifyChecksAllOk(layer4Checks)) {
          throw new Error(
            `Layer 4 verify failed (activate-strict):\n${formatVerifyReport(layer4Checks)}`
          );
        }
      }
    } else if (options.postActivate) {
      progress.report({ message: "Verifying activation..." });
      const activationChecks = await verifyActivationChecks(conversationId);
      verifyChecks.push(...activationChecks);
      for (const c of activationChecks) {
        logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
      }
      if (!verifyChecksAllOk(activationChecks)) {
        throw new Error(
          `Activation verify failed:\n${formatVerifyReport(activationChecks)}`
        );
      }
    }
  } else {
    logChatRestoreDebug("[dry-run] skipped disk and activation verify");
    if (activate) {
      await runPostImportActivation(workingBundle, conversationId, wsCtx, {
        activateStrict: options.activateStrict,
        bridgeWaitResultMs: options.bridgeWaitResultMs,
        dryRun: true,
        extensionPath,
        skipPythonBridge: true,
        log: (line) => logChatRestoreDebug(line),
      });
    }
    if (options.pingServer) {
      pingServerProbe(conversationId, (line) => logChatRestoreDebug(line));
    }
  }

  if (!dryRun) {
    await pruneOldBackups(context);
  }

  const fidelity = summarizeBundleFidelity(workingBundle);
  for (const fw of fidelity.warnings) {
    if (!warnings.includes(fw)) {
      warnings.push(fw);
    }
  }
  publishImportFidelitySummary(conversationId, fidelity);

  const result: LoadChatResult = {
    conversationId,
    transcriptsWritten,
    storeWritten,
    storeWorkspaceKey,
    restoredFolder: folderFsPath,
    sourceFolderTilde: bundle.sourceFolderTilde,
    activated: activate,
    sidebarMerged,
    warnings,
    verifyChecks: verifyChecks.length > 0 ? verifyChecks : undefined,
    fidelity,
  };
  logChatRestoreDebug(
    `restoreChatBundle done conversationId=${conversationId} transcriptsWritten=${transcriptsWritten} storeWritten=${storeWritten} storeWorkspaceKey=${storeWorkspaceKey} sidebarMerged=${sidebarMerged} fidelity schemaVersion=${fidelity.schemaVersion} diskKvRows=${fidelity.diskKvRowCount} toolBubbles=${fidelity.toolBubbleCount} textOnlyLayer4=${fidelity.textOnlyLayer4} warnings=${warnings.length}${warnings.length > 0 ? ` [${warnings.join("; ")}]` : ""}`
  );
  void recordImportEntry(context, {
    conversationId,
    transcriptsWritten,
    storeWritten,
    sidebarMerged,
    warnings: warnings.length,
    timestamp: new Date().toISOString(),
    ...fidelityFieldsForImportHistory(fidelity),
  });
  return result;
}

export async function enrichImportResultWithBundleInspect(
  context: vscode.ExtensionContext,
  bundlePath: string,
  bundle: ChatBundle,
  result: LoadChatResult
): Promise<LoadChatResult> {
  const extensionPath = context.extensionPath;
  try {
    const inspectOutcome = await runPythonBundleInspect({
      bundlePath,
      extensionPath,
      log: (line) => logChatRestoreDebug(line),
    });
    if (inspectOutcome.ok) {
      const fromInspect = parsePythonInspectStdout(inspectOutcome.stdout);
      if (fromInspect) {
        const merged = mergeFidelitySummaries(
          result.fidelity ?? summarizeBundleFidelity(bundle),
          fromInspect
        );
        result.fidelity = merged;
        for (const fw of merged.warnings) {
          if (!result.warnings.includes(fw)) {
            result.warnings.push(fw);
          }
        }
        publishImportFidelitySummary(result.conversationId, merged);
      }
    }
  } catch (err) {
    logChatRestoreDebug(
      `bundle inspect skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return result;
}

export async function loadChat(
  context: vscode.ExtensionContext,
  bundlePath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  restoreOptions: RestoreChatBundleOptions
): Promise<LoadChatResult> {
  progress.report({ message: "Reading bundle..." });
  const raw = await fs.readFile(bundlePath, "utf-8");
  const parsed = parseChatBundleOrCollection(raw);
  if (parsed.kind === "collection" && parsed.collection.bundles.length > 1) {
    throw new Error(
      "This file contains multiple conversations. Use Cursor Sync: Import Chat Bundle to import them."
    );
  }
  const parsedBundle =
    parsed.kind === "single" ? parsed.bundle : parsed.collection.bundles[0]!;
  const result = await restoreChatBundle(context, parsedBundle, progress, restoreOptions);
  return enrichImportResultWithBundleInspect(context, bundlePath, parsedBundle, result);
}

export const __chatPersistenceTestUtils = {
  promptForTargetProject,
};
