import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { withRetry } from "./retry.js";
import { getLogger, loadSyncState, saveSyncState } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  applyRepoSettingsToSyncState,
  createRemoteBackend,
  parseOwnerRepo,
  persistDestinationSettings,
  readDestinationSettings,
} from "./remote/index.js";
import { RepoBackend } from "./remote/repo-backend.js";
import { ensureRepoExistsInteractive } from "./remote/ensure-repo.js";

const SECRET_KEY = "cursorSync.githubPAT";

export async function configureGithub(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  let dest = readDestinationSettings();
  const scopeHint =
    dest.type === "repo"
      ? "requires repo scope (or fine-grained access to the target repository)"
      : "requires gist scope";

  const pat = await vscode.window.showInputBox({
    prompt: `Enter your GitHub Personal Access Token (${scopeHint})`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: "ghp_xxxxxxxxxxxx",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Token cannot be empty";
      }
      return undefined;
    },
  });

  if (!pat) {
    return;
  }

  const token = pat.trim();

  if (dest.type === "repo") {
    let repo = dest.repo;
    if (!parseOwnerRepo(repo || "")) {
      const entered = await vscode.window.showInputBox({
        prompt: "GitHub repository (owner/name)",
        ignoreFocusOut: true,
        placeHolder: "owner/repo",
        value: repo && !repo.includes("/") ? `${repo}/` : repo || "",
        validateInput: (value) => {
          if (!parseOwnerRepo(value || "")) {
            return "Use owner/name format (example: FaberVi/cursor-backup)";
          }
          return undefined;
        },
      });
      if (!entered) {
        return;
      }
      repo = entered.trim();
    }

    const parsed = parseOwnerRepo(repo);
    if (!parsed) {
      vscode.window.showErrorMessage("Invalid repository. Use owner/name.");
      return;
    }

    // Always persist/normalize current destination (incl. path) into settings.
    dest = await persistDestinationSettings({
      type: "repo",
      repo,
      branch: dest.branch,
      path: dest.path,
    });

    const backend = new RepoBackend({
      pat: token,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: dest.branch,
      basePath: dest.path,
    });
    const result = await ensureRepoExistsInteractive(backend);
    if (!result.ok) {
      logger.appendLine(
        `[${new Date().toISOString()}] Token/repo validation failed: ${result.error.message}`
      );
      vscode.window.showErrorMessage(
        `GitHub repository validation failed: ${result.error.message}`
      );
      return;
    }
  } else {
    const client = new GistClient(token);
    const result = await withRetry(() => client.validateToken());
    if (!result.ok) {
      logger.appendLine(
        `[${new Date().toISOString()}] Token validation failed: ${result.error.message}`
      );
      vscode.window.showErrorMessage(
        `GitHub token validation failed: ${result.error.message}`
      );
      return;
    }
  }

  await context.secrets.store(SECRET_KEY, token);
  await vscode.commands.executeCommand("setContext", "cursorSync.configured", true);

  // Re-Connect repository: replace saved sync-state path/repo/branch with
  // whatever is currently in settings (even if already connected).
  if (dest.type === "repo") {
    const previous = await loadSyncState(context);
    const previousPath = previous?.destination?.basePath;
    const applied = applyRepoSettingsToSyncState(previous, dest);
    if (applied) {
      await saveSyncState(context, applied);
      if (previousPath && previousPath !== dest.path) {
        logger.appendLine(
          `[${new Date().toISOString()}] Repo sync path updated: ${previousPath} → ${dest.path}`
        );
        vscode.window.showInformationMessage(
          `Repository path updated to "${dest.path}". Next push/pull will use this folder.`
        );
      }
    }
  }

  const syncState = await loadSyncState(context);
  const lastSync = syncState ? new Date(syncState.lastSyncTimestamp) : undefined;
  updateStatusBar("ok", lastSync);

  vscode.window.showInformationMessage("GitHub token configured successfully.");
  logger.appendLine(`[${new Date().toISOString()}] GitHub token configured`);

  try {
    const backend = createRemoteBackend(context, token, syncState);
    if (!backend) {
      sendEvent(context, "user_configured", { has_existing_remote: false });
      refreshSidebar();
      return;
    }
    const discovered = await withRetry(() => backend.discover());
    if (discovered.ok && discovered.data) {
      sendEvent(context, "user_configured", {
        has_existing_remote: true,
        destination_type: backend.type,
      });
      const remoteId = discovered.data.id;
      const current = await loadSyncState(context);
      const needsUpdate =
        !current ||
        (backend.type === "gist"
          ? current.gistId !== remoteId
          : current.destination?.type !== "repo" ||
            current.destination.basePath !==
              (backend instanceof RepoBackend ? backend.getBasePath() : undefined) ||
            `${current.destination.owner}/${current.destination.repo}` !== remoteId);
      if (needsUpdate) {
        const { buildSyncStateAfterWrite } = await import("./remote/factory.js");
        let next = buildSyncStateAfterWrite(
          current,
          backend,
          remoteId,
          current?.localChecksums || {},
          current?.lastSyncDirection || "pull"
        );
        if (backend.type === "repo") {
          next = applyRepoSettingsToSyncState(next, readDestinationSettings()) ?? next;
        }
        await saveSyncState(context, next);
        logger.appendLine(
          `[${new Date().toISOString()}] Discovered existing remote: ${remoteId}`
        );
        vscode.window.showInformationMessage(
          backend.type === "gist"
            ? "Found existing Cursor Sync Gist. You can now pull your settings."
            : "Repository accessible. You can now pull your settings."
        );

        const newSyncState = await loadSyncState(context);
        updateStatusBar(
          "ok",
          newSyncState ? new Date(newSyncState.lastSyncTimestamp) : undefined
        );
      }
      refreshSidebar();
    } else {
      sendEvent(context, "user_configured", {
        has_existing_remote: false,
        destination_type: backend.type,
      });
      refreshSidebar();
    }
  } catch (err) {
    logger.appendLine(
      `[${new Date().toISOString()}] Error discovering existing remote: ${err instanceof Error ? err.message : String(err)}`
    );
    sendEvent(context, "user_configured", { has_existing_remote: false });
    refreshSidebar();
  }
}

export async function getToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function requireToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const token = await getToken(context);
  if (!token) {
    const action = await vscode.window.showWarningMessage(
      "GitHub token not configured. Configure now?",
      "Configure"
    );
    if (action === "Configure") {
      await configureGithub(context);
      return getToken(context);
    }
    return undefined;
  }
  return token;
}

export async function clearToken(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}

export async function validateStoredToken(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const token = await getToken(context);
  if (!token) {
    return false;
  }

  const dest = readDestinationSettings();
  if (dest.type === "repo") {
    const parsed = parseOwnerRepo(dest.repo);
    if (!parsed) {
      return true;
    }
    const backend = new RepoBackend({
      pat: token,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: dest.branch,
      basePath: dest.path,
    });
    const result = await withRetry(() => backend.validateAccess());
    if (!result.ok) {
      vscode.window.showErrorMessage(
        "Stored GitHub token cannot access the configured repository. Please reconfigure."
      );
      await vscode.commands.executeCommand("setContext", "cursorSync.configured", false);
      updateStatusBar("unconfigured");
      return false;
    }
    return true;
  }

  const client = new GistClient(token);
  const result = await withRetry(() => client.validateToken());

  if (!result.ok) {
    vscode.window.showErrorMessage(
      "Stored GitHub token is no longer valid. Please reconfigure."
    );
    await vscode.commands.executeCommand("setContext", "cursorSync.configured", false);
    updateStatusBar("unconfigured");
    return false;
  }

  return true;
}
