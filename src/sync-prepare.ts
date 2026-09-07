import * as vscode from "vscode";
import { requireToken, validateStoredToken } from "./auth.js";
import { GitHubRepoClient, githubCommitIdentity } from "./github-repo.js";
import { ensureRepoExistsInteractive } from "./remote/ensure-repo.js";
import { parseOwnerRepo, readDestinationSettings } from "./remote/destination.js";
import {
  divergedMessage,
  ensureSyncClone,
  originAheadMessage,
  relationToOrigin,
  type EnsuredClone,
  type GitRelation,
} from "./sync-clone.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import { addSyncHistoryEntry, getLogger } from "./diagnostics.js";
import { sendEvent } from "./analytics.js";
import type { SyncProgressReport } from "./sync-progress-events.js";

export type SyncOpTrigger = "manual" | "scheduled" | "syncNow";

export type PreparedRepoSync = {
  token: string;
  clone: EnsuredClone;
  relation: GitRelation;
  userName: string;
  userEmail: string;
};

export async function failAuth(
  context: vscode.ExtensionContext,
  direction: "push" | "pull",
  trigger: SyncOpTrigger,
  message: string
): Promise<false> {
  void showSyncFailureWithDebug(
    context,
    buildSyncDebugFailure(direction, trigger === "syncNow" ? "manual" : trigger, message, {
      direction,
      category: "AUTH_FAILED",
    }),
    { title: message }
  );
  getLogger().appendLine(`[${new Date().toISOString()}] ${direction} failed: AUTH_FAILED`);
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction,
    trigger,
    fileCount: 0,
    success: false,
    error: message,
  });
  sendEvent(context, "sync_failed", { direction, reason: "AUTH_FAILED", trigger });
  return false;
}

export async function failSync(
  context: vscode.ExtensionContext,
  direction: "push" | "pull",
  trigger: SyncOpTrigger,
  message: string,
  category = "UNKNOWN"
): Promise<false> {
  void showSyncFailureWithDebug(
    context,
    buildSyncDebugFailure(direction, trigger === "syncNow" ? "manual" : trigger, message, {
      direction,
      category,
    }),
    { title: `${direction === "push" ? "Push" : "Pull"} failed: ${message}` }
  );
  getLogger().appendLine(`[${new Date().toISOString()}] ${direction} failed: ${message}`);
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction,
    trigger,
    fileCount: 0,
    success: false,
    error: message,
  });
  sendEvent(context, "sync_failed", { direction, reason: category, trigger });
  return false;
}

export async function prepareRepoSync(
  context: vscode.ExtensionContext,
  direction: "push" | "pull",
  trigger: SyncOpTrigger,
  progress: vscode.Progress<SyncProgressReport>
): Promise<PreparedRepoSync | undefined> {
  const authFailedMessage = "GitHub token not configured. Configure your token to sync.";

  progress.report({ message: "Checking GitHub token…" });
  if (!(await validateStoredToken(context))) {
    const token = await requireToken(context);
    if (!token) {
      await failAuth(context, direction, trigger, authFailedMessage);
      return undefined;
    }
  }

  const token = await requireToken(context);
  if (!token) {
    await failAuth(context, direction, trigger, authFailedMessage);
    return undefined;
  }

  const dest = readDestinationSettings();
  const parsed = parseOwnerRepo(dest.repo);
  if (!parsed) {
    await failSync(
      context,
      direction,
      trigger,
      "Repository is not configured (cursorSync.destination.repo as owner/name).",
      "not_configured"
    );
    return undefined;
  }

  const client = new GitHubRepoClient(token, parsed.owner, parsed.repo);
  if (trigger === "manual") {
    progress.report({ message: "Verifying repository…" });
    const ensured = await ensureRepoExistsInteractive(client);
    if (!ensured.ok) {
      await failSync(context, direction, trigger, ensured.error.message, ensured.error.category);
      return undefined;
    }
  }

  progress.report({ message: "Resolving GitHub user…" });
  const loginResult = await client.getAuthenticatedLogin();
  if (!loginResult.ok) {
    await failSync(
      context,
      direction,
      trigger,
      `Could not read GitHub user for commit identity: ${loginResult.error.message}`,
      loginResult.error.category
    );
    return undefined;
  }
  const identity = githubCommitIdentity(loginResult.data);

  progress.report({ message: "Updating local git clone…" });
  const clone = await ensureSyncClone(context, token);
  const relation = clone.empty
    ? "empty"
    : await relationToOrigin(clone.clonePath, clone.identity.branch);

  return {
    token,
    clone,
    relation,
    userName: identity.name,
    userEmail: identity.email,
  };
}

export function blockOnRelation(
  relation: GitRelation,
  mode: "push" | "pull"
): string | undefined {
  if (relation === "diverged") {
    return divergedMessage();
  }
  if (mode === "push" && relation === "behind") {
    return originAheadMessage();
  }
  return undefined;
}
