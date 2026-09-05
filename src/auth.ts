import * as vscode from "vscode";
import { withRetry } from "./retry.js";
import { getLogger, loadSyncState, saveSyncState } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  applyRepoSettingsToSyncState,
  parseOwnerRepo,
  persistDestinationSettings,
  readDestinationSettings,
} from "./remote/destination.js";
import { GitHubRepoClient } from "./github-repo.js";
import { ensureRepoExistsInteractive } from "./remote/ensure-repo.js";

const SECRET_KEY = "cursorSync.githubPAT";

export async function configureGithub(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  let dest = readDestinationSettings();

  const pat = await vscode.window.showInputBox({
    prompt:
      "Enter your GitHub Personal Access Token (requires repo scope, or fine-grained access to the target repository)",
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

  dest = await persistDestinationSettings({
    repo,
    branch: dest.branch,
    path: dest.path,
  });

  const client = new GitHubRepoClient(token, parsed.owner, parsed.repo);
  const result = await ensureRepoExistsInteractive(client);
  if (!result.ok) {
    logger.appendLine(
      `[${new Date().toISOString()}] Token/repo validation failed: ${result.error.message}`
    );
    vscode.window.showErrorMessage(
      `GitHub repository validation failed: ${result.error.message}`
    );
    return;
  }

  await context.secrets.store(SECRET_KEY, token);
  await refreshConfiguredContext(context);

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

  const syncState = await loadSyncState(context);
  const lastSync = syncState ? new Date(syncState.lastSyncTimestamp) : undefined;
  updateStatusBar("ok", lastSync);

  vscode.window.showInformationMessage("GitHub token configured successfully.");
  logger.appendLine(`[${new Date().toISOString()}] GitHub token configured`);

  try {
    const access = await withRetry(() => client.validateAccess());
    sendEvent(context, "user_configured", {
      has_existing_remote: access.ok,
      destination_type: "repo",
    });
    if (access.ok) {
      vscode.window.showInformationMessage(
        "Repository accessible. You can now pull your settings."
      );
    }
    refreshSidebar();
  } catch (err) {
    logger.appendLine(
      `[${new Date().toISOString()}] Error discovering existing remote: ${err instanceof Error ? err.message : String(err)}`
    );
    sendEvent(context, "user_configured", { has_existing_remote: false });
    refreshSidebar();
  }
}

export async function refreshConfiguredContext(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const token = await getToken(context);
  const configured = Boolean(token && parseOwnerRepo(readDestinationSettings().repo));
  await vscode.commands.executeCommand("setContext", "cursorSync.configured", configured);
  return configured;
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
  const parsed = parseOwnerRepo(dest.repo);
  if (!parsed) {
    return true;
  }
  const client = new GitHubRepoClient(token, parsed.owner, parsed.repo);
  const result = await withRetry(() => client.validateAccess());
  if (!result.ok) {
    vscode.window.showErrorMessage(
      "Stored GitHub token cannot access the configured repository. Please reconfigure (repo scope required)."
    );
    await vscode.commands.executeCommand("setContext", "cursorSync.configured", false);
    updateStatusBar("unconfigured");
    return false;
  }
  return true;
}
