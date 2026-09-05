import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import { createBackup, pruneOldBackups, rollbackFromBackup } from "./rollback.js";
import { computeArtifactChecksum } from "./transcript-bundle.js";
import { accessPathOutcome } from "./transcripts-sqlite.js";
import type {
  DelayedWritebackHandle,
  RestoreOperation,
  RestorePreview,
} from "./transcripts-internal-types.js";
import { applySidebarStateRestoration } from "./transcripts-import-sidebar.js";

export async function previewAndApplyImportPlan(
  context: vscode.ExtensionContext,
  operations: RestoreOperation[],
  actionLabel: string,
  logger: ReturnType<typeof getLogger>,
  options: {
    importRestoreReport: boolean;
    warnings?: string[];
  }
): Promise<void> {
  const preview = await previewRestoreOperations(operations);

  if (preview.newFiles.length === 0 && preview.conflicts.length === 0 && preview.unchanged.length === 0) {
    vscode.window.showInformationMessage(
      `${actionLabel} skipped: no artifacts selected.`
    );
    return;
  }

  if (preview.newFiles.length === 0 && preview.conflicts.length === 0) {
    const sidebarOps = preview.unchanged.filter((op) => op.kind === "sidebar");
    if (options.importRestoreReport && sidebarOps.length > 0) {
      try {
        const stateOutcome = await applySidebarStateRestoration(context, sidebarOps, logger, {
          scheduleDelayedWriteback: true,
        });
        const sidebarMerged = stateOutcome.stateDbMerged > 0;

        vscode.window.showInformationMessage(
          `Transcript import: ${preview.unchanged.length} unchanged${sidebarMerged ? ", sidebar updated" : ""}.`
        );

        if (sidebarMerged) {
          const config = vscode.workspace.getConfiguration("cursorSync");
          const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
          if (autoReload) {
            await stateOutcome.delayedWriteback?.complete();
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          } else {
            const reloadAction = "Reload Window";
            const selected = await vscode.window.showInformationMessage(
              "Sidebar updated. Reload Cursor to see imported conversations.",
              reloadAction
            );
            if (selected === reloadAction) {
              await stateOutcome.delayedWriteback?.complete();
              await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          }
        }
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript import (unchanged files): sidebarMerged=${stateOutcome.stateDbMerged} skippedPayload=${stateOutcome.stateDbSkippedNoPayload} skippedDb=${stateOutcome.stateDbSkippedNoDb} delayedWriteback=${stateOutcome.delayedWriteback ? "scheduled" : "none"}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Transcript import: sidebar state merge failed: ${msg}`
        );
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript import (unchanged files) state merge error: ${msg}`
        );
      }
      return;
    }
  }

  const summary = [
    `${operations.length} artifact(s) selected`,
    `${preview.newFiles.length} new`,
    `${preview.conflicts.length} conflict${preview.conflicts.length === 1 ? "" : "s"}`,
    `${preview.unchanged.length} unchanged`,
  ].join(", ");

  let conflictPolicy: "overwrite" | "skip" = "overwrite";
  if (preview.conflicts.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${actionLabel}: ${summary}. Choose how to handle conflicts.`,
      { modal: true },
      "Overwrite Conflicts",
      "Skip Conflicts",
      "Cancel"
    );

    if (choice === "Cancel" || !choice) {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during conflict review`);
      return;
    }

    conflictPolicy = choice === "Skip Conflicts" ? "skip" : "overwrite";
  } else {
    const choice = await vscode.window.showInformationMessage(
      `${actionLabel}: ${summary}. Use the Import action to write files and update sidebar state.`,
      { modal: true },
      "Import",
      "Cancel"
    );

    if (choice !== "Import") {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during preview confirmation`);
      return;
    }
  }

  const toWrite = [
    ...preview.newFiles,
    ...(conflictPolicy === "overwrite" ? preview.conflicts : []),
  ].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));

  const allSidebarOps = [
    ...preview.newFiles,
    ...(conflictPolicy === "overwrite" ? preview.conflicts : []),
    ...preview.unchanged,
  ].filter((op) => op.kind === "sidebar");

  if (toWrite.length === 0 && allSidebarOps.length === 0) {
    vscode.window.showInformationMessage(
      `${actionLabel}: everything already up to date.`
    );
    return;
  }

  let writtenCount = 0;
  if (toWrite.length > 0) {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Writing ${toWrite.length} transcript artifact(s)...`,
        cancellable: false,
      },
      async () => applyRestoreOperations(context, toWrite, logger)
    );

    if (!result.ok) {
      vscode.window.showErrorMessage(result.message);
      return;
    }
    writtenCount = result.writtenCount;
  }

  let sidebarMerged = false;
  let delayedWritebackHandle: DelayedWritebackHandle | undefined;
  if (options.importRestoreReport && allSidebarOps.length > 0) {
    try {
      const stateOutcome = await applySidebarStateRestoration(context, allSidebarOps, logger, {
        scheduleDelayedWriteback: true,
      });
      sidebarMerged = stateOutcome.stateDbMerged > 0;
      delayedWritebackHandle = stateOutcome.delayedWriteback;
      if (stateOutcome.warnings.length > 0) {
        for (const w of stateOutcome.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [import] ${w}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.appendLine(`[${new Date().toISOString()}] [import] sidebar state merge failed: ${msg}`);
    }
  }

  const parts: string[] = [];
  if (writtenCount > 0) parts.push(`${writtenCount} written`);
  if (preview.unchanged.length > 0) parts.push(`${preview.unchanged.length} unchanged`);
  const skipped = conflictPolicy === "skip" ? preview.conflicts.length : 0;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (sidebarMerged) parts.push("sidebar updated");

  const warningParts = [...(options.warnings ?? [])];
  const warningSuffix =
    warningParts.length > 0 ? ` (${warningParts.length} warning${warningParts.length === 1 ? "" : "s"})` : "";

  vscode.window.showInformationMessage(
    `Transcript import complete: ${parts.join(", ")}.${warningSuffix}`
  );

  if (sidebarMerged) {
    const config = vscode.workspace.getConfiguration("cursorSync");
    const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
    if (autoReload) {
      await delayedWritebackHandle?.complete();
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else {
      const reloadAction = "Reload Window";
      const selected = await vscode.window.showInformationMessage(
        "Sidebar updated. Reload Cursor to see imported conversations.",
        reloadAction
      );
      if (selected === reloadAction) {
        await delayedWritebackHandle?.complete();
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Transcript import succeeded: ${writtenCount} written, ${preview.unchanged.length} unchanged, sidebarMerged=${sidebarMerged} delayedWriteback=${delayedWritebackHandle ? "scheduled" : "none"}`
  );
}

export async function previewRestoreOperations(
  operations: RestoreOperation[]
): Promise<RestorePreview> {
  const preview: RestorePreview = {
    newFiles: [],
    conflicts: [],
    unchanged: [],
  };

  for (const operation of operations) {
    try {
      const existing = await fs.readFile(operation.absolutePath);
      const existingChecksum = computeArtifactChecksum(existing);
      if (existingChecksum === operation.checksum) {
        preview.unchanged.push(operation);
      } else {
        preview.conflicts.push(operation);
      }
    } catch {
      preview.newFiles.push(operation);
    }
  }

  return preview;
}

export async function applyRestoreOperations(
  context: vscode.ExtensionContext,
  operations: RestoreOperation[],
  logger: ReturnType<typeof getLogger>
): Promise<
  | { ok: true; writtenCount: number }
  | { ok: false; message: string }
> {
  const existingPaths: string[] = [];
  const createdPaths: string[] = [];

  for (const operation of operations) {
    const outcome = await accessPathOutcome(operation.absolutePath);
    if (outcome === "timeout") {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript import: access timed out for ${operation.absolutePath}`
      );
      return {
        ok: false,
        message:
          "Transcript import failed: a destination path did not respond in time (slow disk, network folder, or permission issue).",
      };
    }
    if (outcome === "exists") {
      existingPaths.push(operation.absolutePath);
    } else {
      createdPaths.push(operation.absolutePath);
    }
  }

  const { entries: backupEntries } = await createBackup(context, existingPaths);

  let writtenCount = 0;

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i]!;
    try {
      await fs.mkdir(path.dirname(operation.absolutePath), { recursive: true });
      const tmpPath = `${operation.absolutePath}.tmp`;
      await fs.writeFile(tmpPath, operation.content);
      await fs.rename(tmpPath, operation.absolutePath);
      writtenCount += 1;
    } catch (error) {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript write failed for ${operation.absolutePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      await rollbackFromBackup(backupEntries);
      await Promise.all(
        createdPaths.map((createdPath) => fs.rm(createdPath, { force: true }).catch(() => undefined))
      );
      return {
        ok: false,
        message: "Transcript import failed: file write error. Existing files were rolled back.",
      };
    }
  }

  await pruneOldBackups(context);

  return { ok: true, writtenCount };
}
