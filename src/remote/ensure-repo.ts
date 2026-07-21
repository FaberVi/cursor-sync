import * as vscode from "vscode";
import type { ApiResult } from "../types.js";
import { withRetry } from "../retry.js";
import { getLogger } from "../diagnostics.js";
import type { RepoBackend } from "./repo-backend.js";

/**
 * Validate repo access; if missing (404), ask the user whether to create it.
 */
export async function ensureRepoExistsInteractive(
  backend: RepoBackend
): Promise<ApiResult<boolean>> {
  const logger = getLogger();
  const result = await withRetry(() => backend.validateAccess());
  if (result.ok) {
    return result;
  }

  if (result.error.statusCode !== 404) {
    return result;
  }

  const identity = backend.getIdentity();
  const choice = await vscode.window.showWarningMessage(
    `Repository ${identity} does not exist. Create it on GitHub?`,
    { modal: true },
    "Create private",
    "Create public",
    "Cancel"
  );

  if (choice !== "Create private" && choice !== "Create public") {
    return {
      ok: false,
      error: {
        category: "UNKNOWN",
        message: `Repository ${identity} does not exist.`,
        statusCode: 404,
      },
    };
  }

  const created = await backend.createRepository({
    isPrivate: choice === "Create private",
  });
  if (!created.ok) {
    logger.appendLine(
      `[${new Date().toISOString()}] Repo create failed: ${created.error.message}`
    );
    return created;
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Created repository ${created.data.full_name} (${created.data.html_url})`
  );
  vscode.window.showInformationMessage(
    `Created ${choice === "Create private" ? "private" : "public"} repository ${created.data.full_name}.`
  );
  return { ok: true, data: true };
}
