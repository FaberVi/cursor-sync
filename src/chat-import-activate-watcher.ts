import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import {
  archiveFailedPending,
  defaultActivationPaths,
  normalizeActivationManifest,
  runComposerActivation,
  type ActivationManifest,
  type ActivationPaths,
  type RunComposerActivationOptions,
} from "./chat-import-activate.js";

export interface ActivationWatcherOptions {
  paths?: ActivationPaths;
  debounceMs?: number;
  waitResultMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_DEBOUNCE_MS = 300;

let watcherDisposable: vscode.Disposable | undefined;
let workspaceFoldersDisposable: vscode.Disposable | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let processing = false;

export function activationWorkspaceMatches(
  workspaceFolder: string,
  folders: readonly vscode.WorkspaceFolder[] | undefined
): boolean {
  const target = path.resolve(workspaceFolder);
  if (!folders?.length) {
    return false;
  }
  for (const wf of folders) {
    if (path.resolve(wf.uri.fsPath) === target) {
      return true;
    }
  }
  return false;
}

export async function loadPendingManifest(
  paths: ActivationPaths
): Promise<ActivationManifest | null> {
  try {
    const text = await fs.readFile(paths.pendingPath, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    return normalizeActivationManifest(raw);
  } catch {
    return null;
  }
}

async function clearPendingAfterSuccess(paths: ActivationPaths): Promise<void> {
  try {
    await fs.unlink(paths.pendingPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

export async function processPendingActivation(
  options: ActivationWatcherOptions = {}
): Promise<void> {
  if (processing) {
    return;
  }
  processing = true;
  const paths = options.paths ?? defaultActivationPaths();
  const log = options.log ?? (() => {});

  try {
    const manifest = await loadPendingManifest(paths);
    if (!manifest) {
      return;
    }

    if (!activationWorkspaceMatches(manifest.workspaceFolder, vscode.workspace.workspaceFolders)) {
      log(
        `import-activation: pending.json targets ${manifest.workspaceFolder}; no matching open workspace folder`
      );
      return;
    }

    log(
      `import-activation: processing pending.json composerId=${manifest.composerId} workspace=${manifest.workspaceFolder}`
    );

    const runOptions: RunComposerActivationOptions = {
      paths,
      waitResultMs: Math.max(0, options.waitResultMs ?? 0),
      log,
    };
    const outcome = await runComposerActivation(manifest, runOptions);

    if (outcome.ok && !outcome.stagedOnly) {
      await clearPendingAfterSuccess(paths);
      return;
    }

    if (!outcome.ok) {
      log(
        `import-activation: activation failed exitCode=${outcome.exitCode} stagedOnly=${outcome.stagedOnly}`
      );
      if (outcome.stagedOnly) {
        await archiveFailedPending(paths);
        log(
          `import-activation: archived pending manifest to ${paths.pendingPath}.failed (no retry loop)`
        );
      }
    }
  } finally {
    processing = false;
  }
}

function scheduleProcessPending(options: ActivationWatcherOptions): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    void processPendingActivation(options);
  }, debounceMs);
}

export function registerActivationWatcher(
  context: vscode.ExtensionContext,
  options: ActivationWatcherOptions = {}
): void {
  disposeActivationWatcher();

  const paths = options.paths ?? defaultActivationPaths();
  const merged: ActivationWatcherOptions = {
    ...options,
    paths,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    log: options.log ?? ((message: string) => getLogger().appendLine(message)),
  };
  const pendingPattern = new vscode.RelativePattern(
    vscode.Uri.file(paths.activationDir),
    "pending.json"
  );
  const watcher = vscode.workspace.createFileSystemWatcher(
    pendingPattern,
    false,
    false,
    true
  );

  watcher.onDidCreate(() => scheduleProcessPending(merged));
  watcher.onDidChange(() => scheduleProcessPending(merged));

  workspaceFoldersDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() =>
    scheduleProcessPending(merged)
  );

  watcherDisposable = new vscode.Disposable(() => {
    watcher.dispose();
    workspaceFoldersDisposable?.dispose();
    workspaceFoldersDisposable = undefined;
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  });

  context.subscriptions.push(watcherDisposable);
  context.subscriptions.push(workspaceFoldersDisposable);

  void processPendingActivation(merged);
}

export function disposeActivationWatcher(): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  watcherDisposable?.dispose();
  watcherDisposable = undefined;
  workspaceFoldersDisposable?.dispose();
  workspaceFoldersDisposable = undefined;
  processing = false;
}
