import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { runGit } from "./git-cli.js";
import { resolveSyncRoots } from "./paths.js";
import { t } from "./sidebar/i18n.js";
import { getSyncClonePath, readRepoIdentity } from "./sync-clone.js";
import { cloneAbsForSyncKey } from "./sync-copy.js";
import { openSyncKeyFile, syncKeyOpenCandidates } from "./sync-key-picker.js";
import { syncKeyToAbsolutePath } from "./sync-local-deletes.js";

export const REMOTE_SYNC_KEY_SCHEME = "cursor-sync-remote";

/** Origin blobs larger than this stay out of the text diff. */
export const REMOTE_BLOB_MAX_BYTES = 1_048_576;

const remoteTextByUri = new Map<string, string>();

export function __resetRemoteSyncKeyCacheForTests(): void {
  remoteTextByUri.clear();
}

function hasDotDot(value: string): boolean {
  return value.split(/[/\\]/).includes("..");
}

/** `origin/<branch>:<basePath>/<syncKey>`, or undefined when the path is unsafe. */
export function originBlobPathspec(
  branch: string,
  basePath: string,
  syncKey: string
): string | undefined {
  if (hasDotDot(branch) || hasDotDot(basePath) || hasDotDot(syncKey)) {
    return undefined;
  }
  const base = basePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const key = syncKey.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!branch || !base || !key || branch.includes(":") || key.includes(":")) {
    return undefined;
  }
  return `origin/${branch}:${base}/${key}`;
}

export async function readOriginBlob(
  clonePath: string,
  branch: string,
  basePath: string,
  syncKey: string
): Promise<{ ok: true; text: string } | { ok: false }> {
  const pathspec = originBlobPathspec(branch, basePath, syncKey);
  if (!pathspec) {
    return { ok: false };
  }
  let stdout: string;
  try {
    const result = await runGit({
      args: ["show", pathspec],
      cwd: clonePath,
    });
    stdout = result.stdout;
  } catch {
    // A missing blob is a git error. The caller opens the on-disk file instead.
    return { ok: false };
  }
  if (stdout.includes("\0") || Buffer.byteLength(stdout, "utf8") > REMOTE_BLOB_MAX_BYTES) {
    return { ok: false };
  }
  return { ok: true, text: stdout };
}

function uriCacheKey(uri: vscode.Uri): string {
  const query = "query" in uri && typeof uri.query === "string" ? uri.query : "";
  return `${uri.scheme}:${uri.path}?${query}`;
}

export function remoteSyncKeyUri(syncKey: string, ref: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REMOTE_SYNC_KEY_SCHEME,
    path: `/${syncKey}`,
    query: `ref=${encodeURIComponent(ref)}`,
  });
}

function rememberRemoteText(uri: vscode.Uri, text: string): void {
  remoteTextByUri.set(uriCacheKey(uri), text);
}

export async function provideRemoteSyncKeyText(
  uri: vscode.Uri,
  context: vscode.ExtensionContext
): Promise<string> {
  const cached = remoteTextByUri.get(uriCacheKey(uri));
  if (cached !== undefined) {
    return cached;
  }
  const identity = readRepoIdentity();
  const syncKey = uri.path.replace(/^\/+/, "");
  if (!identity) {
    throw new Error(t("remoteBlobUnavailable"));
  }
  const blob = await readOriginBlob(
    getSyncClonePath(context),
    identity.branch,
    identity.basePath,
    syncKey
  );
  if (!blob.ok) {
    throw new Error(t("remoteBlobUnavailable"));
  }
  rememberRemoteText(uri, blob.text);
  return blob.text;
}

export function registerRemoteSyncKeyProvider(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(REMOTE_SYNC_KEY_SCHEME, {
    provideTextDocumentContent: (uri) => provideRemoteSyncKeyText(uri, context),
  });
}

function syncKeyFileName(syncKey: string): string {
  const parts = syncKey.split("/");
  return parts[parts.length - 1] || syncKey;
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

function confinedSyncPath(
  candidate: string | undefined,
  allowed: readonly string[]
): string | undefined {
  if (!candidate) {
    return undefined;
  }
  const resolved = path.resolve(candidate);
  return allowed.includes(resolved) ? resolved : undefined;
}

async function showDiff(
  left: vscode.Uri,
  right: vscode.Uri,
  syncKey: string
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    t("syncKeyDiffTitle", { name: syncKeyFileName(syncKey) }),
    { preview: true, viewColumn: vscode.ViewColumn.One }
  );
}

/**
 * Open a remote-versus-local diff when both sides exist.
 * A missing side, or an origin blob that is missing, binary, or over 1 MiB,
 * opens the on-disk file instead and never uses the remote scheme.
 */
export async function openSyncKeyComparison(
  syncKey: string,
  context: vscode.ExtensionContext,
  kind: "local" | "incoming" | "diverged"
): Promise<void> {
  const identity = readRepoIdentity();
  if (!identity) {
    await openSyncKeyFile(syncKey, context);
    return;
  }
  const clone = {
    clonePath: getSyncClonePath(context),
    basePath: identity.basePath,
  };
  const roots = resolveSyncRoots();
  const allowed = syncKeyOpenCandidates(syncKey, roots, clone);
  const cursorAbs = confinedSyncPath(syncKeyToAbsolutePath(syncKey, roots), allowed);
  const cloneAbs = confinedSyncPath(
    cloneAbsForSyncKey(clone.clonePath, clone.basePath, syncKey),
    allowed
  );

  if (kind === "local") {
    if (
      cursorAbs &&
      cloneAbs &&
      (await fileExists(cursorAbs)) &&
      (await fileExists(cloneAbs))
    ) {
      await showDiff(vscode.Uri.file(cloneAbs), vscode.Uri.file(cursorAbs), syncKey);
      return;
    }
    await openSyncKeyFile(syncKey, context);
    return;
  }

  let localSide: string | undefined;
  if (cursorAbs && (await fileExists(cursorAbs))) {
    localSide = cursorAbs;
  } else if (cloneAbs && (await fileExists(cloneAbs))) {
    localSide = cloneAbs;
  }
  if (!localSide) {
    await openSyncKeyFile(syncKey, context);
    return;
  }
  const blob = await readOriginBlob(
    clone.clonePath,
    identity.branch,
    identity.basePath,
    syncKey
  );
  if (!blob.ok) {
    await openSyncKeyFile(syncKey, context);
    return;
  }
  const remoteUri = remoteSyncKeyUri(syncKey, `origin/${identity.branch}`);
  rememberRemoteText(remoteUri, blob.text);
  await showDiff(remoteUri, vscode.Uri.file(localSide), syncKey);
}
