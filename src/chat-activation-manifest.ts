import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatBundle } from "./chat-persistence.js";
import { bundleToPartialState, type PartialState } from "./chat-partial-state.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";

export const CREATE_NEW_COMPOSER_COMMAND_ID = "composer.createNew";
export const CREATE_COMPOSER_COMMAND_ID = "composer.createComposer";
export const COMPOSER_GET_HANDLE_COMMAND_ID = "composer.getComposerHandleById";
export const OPEN_COMPOSER_COMMAND_ID = "composer.openComposer";
export const FOCUS_COMPOSER_COMMAND_ID = "composer.focusComposer";
export const COMPOSER_URI_SCHEME = "cursor.composer";
export const MANIFEST_VERSION = 1;

export const ACTIVATION_DIR = path.join(os.homedir(), ".cursor", "import-activation");
export const ACTIVATION_PENDING_PATH = path.join(ACTIVATION_DIR, "pending.json");
export const ACTIVATION_RESULT_PATH = path.join(ACTIVATION_DIR, "result.json");

export interface ActivationPaths {
  activationDir: string;
  pendingPath: string;
  resultPath: string;
}

export interface ActivationResult {
  ok: boolean;
  composerId?: string;
}

export interface ComposerActivationOutcome {
  ok: boolean;
  composerId?: string;
  exitCode: number;
  stagedOnly: boolean;
}

export interface RunComposerActivationOptions {
  paths?: ActivationPaths;
  waitResultMs?: number;
  /** When false, do not write ~/.cursor/import-activation/pending.json (sidebar Open). */
  stagePending?: boolean;
  /** When true, composer.openComposer without a handle still counts as success (store.db on disk). */
  acceptOpenWithoutHandle?: boolean;
  handlePreloadTimeoutMs?: number;
  handlePostOpenTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface RunPythonComposerBridgeOptions {
  paths?: ActivationPaths;
  waitResultMs?: number;
  dryRun?: boolean;
  bridgeScriptPath?: string | null;
  extensionPath?: string;
  log?: (message: string) => void;
}

export interface RunPostImportActivationOptions {
  paths?: ActivationPaths;
  activateStrict?: boolean;
  bridgeWaitResultMs?: number;
  dryRun?: boolean;
  extensionPath?: string;
  openInNewTab?: boolean;
  /** When true (default inside Cursor Sync), never spawn the Python bridge; IDE only. */
  skipPythonBridge?: boolean;
  log?: (message: string) => void;
}

export interface WaitForActivationResultOptions {
  paths?: ActivationPaths;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RawActivationManifest {
  partialState: PartialState | Record<string, unknown>;
  workspaceFolder: string;
  openInNewTab?: boolean;
  createComposerOptions?: Record<string, unknown>;
}

export interface ActivationManifest {
  version: number;
  composerId: string;
  partialState: PartialState | Record<string, unknown>;
  workspaceFolder: string;
  openInNewTab: boolean;
  createComposerOptions: Record<string, unknown>;
  commandId: string;
  stagedAt: string;
}

export function defaultActivationPaths(): ActivationPaths {
  const activationDir = path.join(os.homedir(), ".cursor", "import-activation");
  return {
    activationDir,
    pendingPath: path.join(activationDir, "pending.json"),
    resultPath: path.join(activationDir, "result.json"),
  };
}

export function utcNowIso(): string {
  return new Date().toISOString();
}

export function composerIdFromPartial(partial: Record<string, unknown>): string {
  const cid = partial.composerId;
  if (typeof cid !== "string" || !cid.trim()) {
    throw new Error("partialState.composerId is required");
  }
  return cid.trim();
}

export function buildActivationManifest(
  bundle: ChatBundle | Record<string, unknown>,
  conversationId: string,
  workspaceCtx: WorkspaceContext,
  options: { openInNewTab?: boolean } = {}
): RawActivationManifest {
  const openInNewTab = options.openInNewTab ?? true;
  const partial = bundleToPartialState(bundle, conversationId, {
    workspaceIdentifier: workspaceCtx.workspaceIdentifier,
  });
  return {
    partialState: partial,
    workspaceFolder: workspaceCtx.folderFsPath,
    openInNewTab,
  };
}

export function normalizeActivationManifest(
  raw: Record<string, unknown>
): ActivationManifest {
  const partial = raw.partialState;
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    throw new Error("manifest.partialState object is required");
  }

  const workspaceFolderRaw = raw.workspaceFolder;
  if (
    typeof workspaceFolderRaw !== "string" ||
    !workspaceFolderRaw.trim()
  ) {
    throw new Error("manifest.workspaceFolder (absolute path) is required");
  }
  let folder = workspaceFolderRaw.trim();
  if (folder === "~") {
    folder = os.homedir();
  } else if (folder.startsWith("~/")) {
    folder = path.join(os.homedir(), folder.slice(2));
  }
  const workspaceFolder = path.resolve(folder);

  let openInNewTab = raw.openInNewTab;
  if (openInNewTab === undefined || openInNewTab === null) {
    openInNewTab = true;
  }
  if (typeof openInNewTab !== "boolean") {
    throw new Error("manifest.openInNewTab must be a boolean");
  }

  const composerId = composerIdFromPartial(partial as Record<string, unknown>);

  let createComposerOptions: Record<string, unknown>;
  const rawOptions = raw.createComposerOptions;
  if (rawOptions === undefined || rawOptions === null) {
    createComposerOptions = { openInNewTab, view: "editor" };
  } else if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new Error("manifest.createComposerOptions must be an object when set");
  } else {
    createComposerOptions = { ...(rawOptions as Record<string, unknown>) };
    if (!("openInNewTab" in createComposerOptions)) {
      createComposerOptions.openInNewTab = openInNewTab;
    }
  }

  return {
    version: MANIFEST_VERSION,
    composerId,
    partialState: partial as PartialState,
    workspaceFolder,
    openInNewTab,
    createComposerOptions,
    commandId: CREATE_COMPOSER_COMMAND_ID,
    stagedAt: utcNowIso(),
  };
}

export async function stagePendingManifest(
  manifest: ActivationManifest,
  paths: ActivationPaths = defaultActivationPaths()
): Promise<string> {
  await fs.mkdir(paths.activationDir, { recursive: true });
  const tmpPath = `${paths.pendingPath}.tmp`;
  const payload = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, paths.pendingPath);
  return paths.pendingPath;
}

export async function writeResultJson(
  composerId: string,
  ok = true,
  paths: ActivationPaths = defaultActivationPaths()
): Promise<void> {
  await fs.mkdir(paths.activationDir, { recursive: true });
  const payload: ActivationResult = {
    ok,
    composerId: composerId.trim(),
  };
  await fs.writeFile(
    paths.resultPath,
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );
}

export async function clearStaleResult(
  paths: ActivationPaths = defaultActivationPaths()
): Promise<void> {
  try {
    await fs.unlink(paths.resultPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

export function parseComposerIdFromCommandResult(
  result: unknown,
  fallbackComposerId: string
): string {
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const cid = (result as Record<string, unknown>).composerId;
    if (typeof cid === "string" && cid.trim()) {
      return cid.trim();
    }
  }
  return fallbackComposerId.trim();
}

function activationManifestFingerprint(manifest: ActivationManifest): string {
  return JSON.stringify({
    composerId: manifest.composerId,
    workspaceFolder: manifest.workspaceFolder,
    commandId: manifest.commandId,
    partialState: manifest.partialState,
    createComposerOptions: manifest.createComposerOptions,
  });
}

export async function pendingManifestMatches(
  manifest: ActivationManifest,
  paths: ActivationPaths = defaultActivationPaths()
): Promise<boolean> {
  try {
    const text = await fs.readFile(paths.pendingPath, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    const onDisk = normalizeActivationManifest(raw);
    return activationManifestFingerprint(onDisk) === activationManifestFingerprint(manifest);
  } catch {
    return false;
  }
}

export async function archiveFailedPending(
  paths: ActivationPaths = defaultActivationPaths()
): Promise<void> {
  const failedPath = `${paths.pendingPath}.failed`;
  try {
    await fs.rename(paths.pendingPath, failedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

export async function readActivationResult(
  paths: ActivationPaths = defaultActivationPaths()
): Promise<ActivationResult | null> {
  try {
    const text = await fs.readFile(paths.resultPath, "utf8");
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const rec = data as Record<string, unknown>;
    if (rec.ok === false) {
      return null;
    }
    const cid = rec.composerId;
    if (typeof cid === "string" && cid.trim()) {
      return { ok: true, composerId: cid.trim() };
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForActivationResult(
  options: WaitForActivationResultOptions = {}
): Promise<string | null> {
  const paths = options.paths ?? defaultActivationPaths();
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 250);

  if (timeoutMs === 0) {
    const one = await readActivationResult(paths);
    return one?.composerId ?? null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readActivationResult(paths);
    if (result?.composerId) {
      return result.composerId;
    }
    await delayMs(pollIntervalMs);
  }
  return null;
}
