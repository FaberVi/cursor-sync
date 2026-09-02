import * as vscode from "vscode";
import { configureGithub, getToken } from "./auth.js";
import { EXTENSION_LABEL } from "./extension-branding.js";
import { executePush } from "./push.js";
import { executePull } from "./pull.js";
import { executeCancelSyncCommand } from "./sync-abort.js";
import { executeExport } from "./export.js";
import { executeImport } from "./import.js";
import { executeExportTranscripts, executeImportTranscripts } from "./transcripts.js";
import {
  executeSaveChatLocal,
  executeLoadChatLocal,
  executeImportChatBundle,
  executeExportChatBundle,
  executeExportCurrentChatBundle,
  executeImportChatBundleActivate,
  executeVerifyChatImport,
} from "./chat-persistence.js";
import { executeValidateChatBackups } from "./chat-backup-validate.js";
import {
  executeExportChatToGist,
  executeExportCurrentChatBundleToGist,
} from "./export-gist-chat.js";
import { executeImportChatFromGist } from "./import-gist-chat.js";
import { executeSetChatEncryptionPassword } from "./chat-encryption-auth.js";
import { executeImportTranscriptsFromGist } from "./import-gist-transcripts.js";
import { showStatus } from "./diagnostics.js";
import { resolveConflictsCommand, loadPendingResolutions } from "./conflicts.js";
import { executeReset } from "./reset.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { getLogger, loadSyncState } from "./diagnostics.js";
import {
  migrateAndLogSkillArtifacts,
  purgeRemoteSkillArtifacts,
} from "./skill-artifacts-migrate.js";
import { initializeSidebar } from "./sidebar/index.js";
import { initializeStatusBar, updateStatusBar } from "./statusbar.js";
import { getOrCreateClientId } from "./analytics.js";
import {
  executeFinalizeStateReconciliation,
  executePrepareStateReconciliation,
  notifyPendingStateBundleIfAny,
} from "./state-reconciliation.js";
import { executePrepareSyncFromLandingZone } from "./sync-engine.js";
import { executeOpenCursorFolder } from "./open-cursor-folder.js";
import {
  disposeActivationWatcher,
  registerActivationWatcher,
} from "./chat-import-activate-watcher.js";
import { flushPendingSidebarWriteback } from "./chat-import-sidebar-writeback.js";
import { executeSyncNow } from "./sync-now.js";

export { executeSyncNow } from "./sync-now.js";

let configListener: vscode.Disposable | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();

  await loadPendingResolutions(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.refreshImportedTranscripts", () => {
      vscode.window.showInformationMessage(
        `Imported Transcripts moved to the Chats tab of the ${EXTENSION_LABEL} sidebar.`
      );
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.openImportedTranscript", () => {
      vscode.window.showInformationMessage(
        `Imported Transcripts moved to the Chats tab of the ${EXTENSION_LABEL} sidebar.`
      );
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.revealImportedTranscriptInExplorer", () => {
      vscode.window.showInformationMessage(
        `Imported Transcripts moved to the Chats tab of the ${EXTENSION_LABEL} sidebar.`
      );
    })
  );

  initializeStatusBar(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.configureGithub", () =>
      configureGithub(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.push", () =>
      executePush(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.pull", () =>
      executePull(context, { mirror: false })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.pullMirror", () =>
      executePull(context, { mirror: true })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.cancelSync", () =>
      executeCancelSyncCommand()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.showStatus", () =>
      showStatus(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.resolveConflicts", () =>
      resolveConflictsCommand(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.reset", () =>
      executeReset(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.export", () =>
      executeExport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.import", () =>
      executeImport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.openCursorFolder", () =>
      executeOpenCursorFolder({ pick: true })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportTranscripts", () =>
      executeExportTranscripts(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importTranscripts", () =>
      executeImportTranscripts(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.saveChatLocal", () =>
      executeSaveChatLocal(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.loadChatLocal", () =>
      executeLoadChatLocal(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importChatBundle", (bundlePath?: string) =>
      executeImportChatBundle(context, bundlePath)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportChatBundle", () =>
      executeExportChatBundle(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportCurrentChatBundle", (target) =>
      executeExportCurrentChatBundle(context, target)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importChatBundleActivate", () =>
      executeImportChatBundleActivate(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.verifyChatImport", () =>
      executeVerifyChatImport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.validateChatBackups", () =>
      executeValidateChatBackups(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportChatToGist", () =>
      executeExportChatToGist(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportCurrentChatBundleToGist", (target) =>
      executeExportCurrentChatBundleToGist(context, target)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importChatFromGist", () =>
      executeImportChatFromGist(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.setChatEncryptionPassword", () =>
      executeSetChatEncryptionPassword(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importTranscriptsFromGist", () =>
      executeImportTranscriptsFromGist(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.syncNow", () =>
      executeSyncNow(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.prepareStateReconciliation", () =>
      executePrepareStateReconciliation(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.finalizeStateReconciliation", () =>
      executeFinalizeStateReconciliation(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.prepareSyncFromLandingZone", () =>
      executePrepareSyncFromLandingZone(context)
    )
  );

  const sidebarProvider = initializeSidebar(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorSync.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  updateConfiguredContext(context);
  getOrCreateClientId(context);
  startScheduler(context);

  configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("cursorSync.schedule")) {
      stopScheduler();
      startScheduler(context);
    }
  });
  context.subscriptions.push(configListener);

  void notifyPendingStateBundleIfAny(context);

  void flushPendingSidebarWriteback(context).then((applied) => {
    if (applied) {
      logger.appendLine(
        `[${new Date().toISOString()}] Applied pending chat import sidebar write-back after reload`
      );
    }
  });

  registerActivationWatcher(context);

  void (async () => {
    try {
      const migrated = await migrateAndLogSkillArtifacts();
      // Publish recovered skills and delete artifact keys in one remote write.
      const purged = await purgeRemoteSkillArtifacts(context, migrated);
      if (purged > 0) {
        logger.appendLine(
          `[${new Date().toISOString()}] Skill artifact migrate: remote write touched ${purged} file(s)`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.appendLine(
        `[${new Date().toISOString()}] Skill artifact migrate failed: ${msg}`
      );
    }
  })();

  logger.appendLine(`[${new Date().toISOString()}] ${EXTENSION_LABEL} activated`);
}

export function deactivate(): void {
  disposeActivationWatcher();
  stopScheduler();
}

async function updateConfiguredContext(
  context: vscode.ExtensionContext
): Promise<void> {
  const token = await getToken(context);
  const isConfigured = token !== undefined;
  
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.configured",
    isConfigured
  );

  if (isConfigured) {
    const syncState = await loadSyncState(context);
    const lastSync = syncState ? new Date(syncState.lastSyncTimestamp) : undefined;
    updateStatusBar("ok", lastSync);
  } else {
    updateStatusBar("unconfigured");
  }
}
