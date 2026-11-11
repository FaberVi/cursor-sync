import * as vscode from "vscode";
import {
  COMPOSER_GET_HANDLE_COMMAND_ID,
  COMPOSER_URI_SCHEME,
  CREATE_COMPOSER_COMMAND_ID,
  CREATE_NEW_COMPOSER_COMMAND_ID,
  FOCUS_COMPOSER_COMMAND_ID,
  OPEN_COMPOSER_COMMAND_ID,
  defaultActivationPaths,
  delayMs,
  parseComposerIdFromCommandResult,
  writeResultJson,
  type ActivationManifest,
  type ActivationPaths,
  type ComposerActivationOutcome,
  type RunComposerActivationOptions,
} from "./chat-activation-manifest.js";
import {
  partialStateForCreateNewCommand,
  partialStateSafeForCreateNew,
} from "./chat-partial-state.js";

export type OpenComposerCommandOptions = {
  openInNewTab?: boolean;
  view?: string;
  openExistingOnly?: boolean;
};

export function buildOpenComposerCommandOptions(
  options: OpenComposerCommandOptions = {}
): Record<string, unknown> {
  return {
    openInNewTab: options.openInNewTab ?? true,
    view: options.view ?? "editor",
    openExistingOnly: options.openExistingOnly ?? true,
  };
}

/** Open an on-disk composer without replacing the active chat tab. */
export async function openExistingComposerInNewTab(
  composerId: string,
  options: { view?: string; log?: (message: string) => void } = {}
): Promise<boolean> {
  const log = options.log ?? (() => {});
  const trimmed = composerId.trim();
  if (!trimmed) {
    return false;
  }
  if (!(await composerCommandAvailable(OPEN_COMPOSER_COMMAND_ID))) {
    return false;
  }
  const openOpts = buildOpenComposerCommandOptions({
    openInNewTab: true,
    view: options.view ?? "editor",
    openExistingOnly: true,
  });
  try {
    await vscode.commands.executeCommand(
      OPEN_COMPOSER_COMMAND_ID,
      trimmed,
      openOpts
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`composer.openComposer (new tab) failed: ${message}`);
    return false;
  }
}

export async function composerCommandAvailable(
  commandId: string = CREATE_COMPOSER_COMMAND_ID
): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  return commands.includes(commandId);
}

export function composerUriForId(composerId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: COMPOSER_URI_SCHEME, path: composerId.trim() });
}

async function fetchComposerHandle(composerId: string): Promise<unknown> {
  return vscode.commands.executeCommand(COMPOSER_GET_HANDLE_COMMAND_ID, composerId);
}

function hasComposerHandle(handle: unknown): boolean {
  return handle !== undefined && handle !== null;
}

export async function waitForComposerHandle(
  composerId: string,
  options: { timeoutMs?: number; pollMs?: number; log?: (message: string) => void } = {}
): Promise<unknown> {
  const log = options.log ?? (() => {});
  if (!(await composerCommandAvailable(COMPOSER_GET_HANDLE_COMMAND_ID))) {
    return undefined;
  }
  const timeoutMs = Math.max(0, options.timeoutMs ?? 8000);
  const pollMs = Math.max(50, options.pollMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await fetchComposerHandle(composerId);
      if (hasComposerHandle(handle)) {
        return handle;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`waitForComposerHandle: ${message}`);
    }
    await delayMs(pollMs);
  }
  return undefined;
}

export async function tryRegisterViaCreateNew(
  manifest: ActivationManifest,
  paths: ActivationPaths,
  log: (message: string) => void
): Promise<ComposerActivationOutcome | null> {
  if (!(await composerCommandAvailable(CREATE_NEW_COMPOSER_COMMAND_ID))) {
    return null;
  }
  const partial = manifest.partialState as Record<string, unknown>;
  const safeForCreateNew = partialStateSafeForCreateNew(partial);
  if (!safeForCreateNew) {
    return null;
  }
  const createNewPartial = partialStateForCreateNewCommand(partial);
  const options: Record<string, unknown> = {
    composerId: manifest.composerId,
    partialState: createNewPartial,
    workspaceFolder: manifest.workspaceFolder,
    ...manifest.createComposerOptions,
  };
  try {
    const commandResult = await vscode.commands.executeCommand(
      CREATE_NEW_COMPOSER_COMMAND_ID,
      options
    );
    const composerId = parseComposerIdFromCommandResult(commandResult, manifest.composerId);
    if (composerId !== manifest.composerId) {
      throw new Error(
        `composer.createNew returned composerId=${composerId}, expected ${manifest.composerId}`
      );
    }
    await writeResultJson(composerId, true, paths);
    log(`composer.createNew succeeded: composerId=${composerId}`);
    return {
      ok: true,
      composerId,
      exitCode: 0,
      stagedOnly: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`composer.createNew failed: ${message}`);
    return {
      ok: false,
      exitCode: 1,
      stagedOnly: false,
    };
  }
}

async function tryOpenViaComposerCommands(
  manifest: ActivationManifest,
  log: (message: string) => void
): Promise<boolean> {
  const openAvailable = await composerCommandAvailable(OPEN_COMPOSER_COMMAND_ID);
  const focusAvailable = await composerCommandAvailable(FOCUS_COMPOSER_COMMAND_ID);
  const openOpts = buildOpenComposerCommandOptions({
    openInNewTab: manifest.openInNewTab,
    view:
      typeof manifest.createComposerOptions.view === "string"
        ? manifest.createComposerOptions.view
        : "editor",
    openExistingOnly: true,
  });

  if (openAvailable) {
    try {
      await vscode.commands.executeCommand(
        OPEN_COMPOSER_COMMAND_ID,
        manifest.composerId,
        openOpts
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`composer.openComposer failed: ${message}`);
      if (!manifest.openInNewTab) {
        try {
          await vscode.commands.executeCommand(
            OPEN_COMPOSER_COMMAND_ID,
            manifest.composerId
          );
          return true;
        } catch (err2) {
          const message2 = err2 instanceof Error ? err2.message : String(err2);
          log(`composer.openComposer (id only) failed: ${message2}`);
        }
      }
    }
  }

  if (!manifest.openInNewTab && focusAvailable) {
    try {
      await vscode.commands.executeCommand(
        FOCUS_COMPOSER_COMMAND_ID,
        manifest.composerId
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`composer.focusComposer failed: ${message}`);
    }
  }

  return false;
}

export async function tryActivateViaComposerHandle(
  manifest: ActivationManifest,
  options: RunComposerActivationOptions = {}
): Promise<ComposerActivationOutcome | null> {
  const paths = options.paths ?? defaultActivationPaths();
  const log = options.log ?? (() => {});

  const handleCmdAvailable = await composerCommandAvailable(
    COMPOSER_GET_HANDLE_COMMAND_ID
  );
  if (!(await composerCommandAvailable(OPEN_COMPOSER_COMMAND_ID)) &&
    !(await composerCommandAvailable(FOCUS_COMPOSER_COMMAND_ID)) &&
    !handleCmdAvailable) {
    return null;
  }

  const preloadMs = Math.max(0, options.handlePreloadTimeoutMs ?? 6000);
  const postOpenMs = Math.max(0, options.handlePostOpenTimeoutMs ?? 4000);
  await waitForComposerHandle(manifest.composerId, {
    timeoutMs: preloadMs,
    pollMs: 250,
    log,
  });

  if (await tryOpenViaComposerCommands(manifest, log)) {
    const handle = await waitForComposerHandle(manifest.composerId, {
      timeoutMs: postOpenMs,
      pollMs: 200,
      log,
    });
    if (hasComposerHandle(handle)) {
      await writeResultJson(manifest.composerId, true, paths);
      log(`Activation OK (composer.openComposer+loaded): composerId=${manifest.composerId}`);
      return {
        ok: true,
        composerId: manifest.composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    }
    if (options.acceptOpenWithoutHandle) {
      await writeResultJson(manifest.composerId, true, paths);
      log(
        `Activation OK (composer.openComposer, no handle; store on disk): composerId=${manifest.composerId}`
      );
      return {
        ok: true,
        composerId: manifest.composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    }
    log(
      `composer.openComposer ran but conversation did not load for composerId=${manifest.composerId}; try Reload Window`
    );
  }

  if (!handleCmdAvailable) {
    return null;
  }

  let handle: unknown;
  try {
    handle = await fetchComposerHandle(manifest.composerId);
  } catch (handleErr) {
    const handleMessage =
      handleErr instanceof Error ? handleErr.message : String(handleErr);
    log(`composer handle activation failed: ${handleMessage}`);
    return null;
  }

  if (hasComposerHandle(handle)) {
    await writeResultJson(manifest.composerId, true, paths);
    log(`Activation OK (handle loaded): composerId=${manifest.composerId}`);
    return {
      ok: true,
      composerId: manifest.composerId,
      exitCode: 0,
      stagedOnly: false,
    };
  }

  log(
    `composer.getComposerHandleById returned no handle for composerId=${manifest.composerId} ` +
      "(store.db may be missing under ~/.cursor/chats/<workspace-key>/)"
  );
  return null;
}
