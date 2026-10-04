import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import {
  annotateExtensionPackages,
  syncPrivateExtensionPackages,
} from "./extension-packages.js";
import { resolveSyncRoots } from "./paths.js";

export interface ExtensionEntry {
  id: string;
  version: string;
  /** `gallery` reinstalls from the store. `vsix` reinstalls from the synced package. */
  source?: "gallery" | "vsix";
  /** Path relative to Cursor User, e.g. `vsix/publisher.name-1.0.0.vsix`. */
  package?: string;
}

type ExtensionPackageJson = {
  version?: string;
  isBuiltin?: boolean;
  isUserBuiltin?: boolean;
};

type SyncableExtension = {
  id: string;
  extensionPath?: string;
  extensionUri?: { fsPath?: string };
  packageJSON?: ExtensionPackageJson;
};

/** Product-bundled Cursor helpers that appear in remote lists without packageJSON flags. */
export function isLikelyProductBuiltinId(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.startsWith("vscode.")) {
    return true;
  }
  // Bundled Cursor helpers (not marketplace anysphere.remote-* / anysphere.cursorpyright).
  if (lower.startsWith("anysphere.cursor-")) {
    return true;
  }
  if (lower.startsWith("cursor.cursor-")) {
    return true;
  }
  if (
    lower === "ms-vscode.js-debug" ||
    lower === "ms-vscode.js-debug-companion" ||
    lower === "ms-vscode.vscode-js-profile-table"
  ) {
    return true;
  }
  if (lower === "everysphere.worktree-textmate") {
    return true;
  }
  if (lower === "undefined_publisher.cursor-themes") {
    return true;
  }
  return false;
}

function isBuiltinByExtensionPath(ext: SyncableExtension): boolean {
  const raw = ext.extensionPath || ext.extensionUri?.fsPath || "";
  if (!raw) {
    return false;
  }
  const normalized = raw.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/resources/app/extensions/");
}

/** User-installed extensions only — excludes VS Code/Cursor builtins. */
export function isSyncableExtension(ext: SyncableExtension): boolean {
  if (ext.id.startsWith("vscode.")) {
    return false;
  }
  const pkg = ext.packageJSON;
  if (pkg?.isBuiltin === true || pkg?.isUserBuiltin === true) {
    return false;
  }
  if (isBuiltinByExtensionPath(ext)) {
    return false;
  }
  if (isLikelyProductBuiltinId(ext.id)) {
    return false;
  }
  return true;
}

/** Marketplace-style id: Publisher.extension-name (rejects path-like / URL-like values). */
const MARKETPLACE_EXTENSION_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9\-]*\.[A-Za-z0-9][A-Za-z0-9\-]*$/;

export function isValidMarketplaceExtensionId(id: string): boolean {
  return MARKETPLACE_EXTENSION_ID_RE.test(id);
}

/** Remote entries safe to auto-install (excludes product builtins still listed on old remotes). */
export function isInstallCandidateExtensionId(id: string): boolean {
  if (!isValidMarketplaceExtensionId(id)) {
    return false;
  }
  return !isLikelyProductBuiltinId(id);
}

/** True when publisher is allowed (empty allowlist = all publishers). */
export function isPublisherAllowed(
  extensionId: string,
  allowedPublishers: readonly string[]
): boolean {
  if (allowedPublishers.length === 0) {
    return true;
  }
  const publisher = extensionId.split(".")[0]?.toLowerCase();
  if (!publisher) {
    return false;
  }
  const allowed = new Set(allowedPublishers.map((p) => p.toLowerCase()));
  return allowed.has(publisher);
}

export function listSyncableExtensionEntries(): ExtensionEntry[] {
  const entries: ExtensionEntry[] = [];
  let filteredBuiltinCount = 0;

  for (const ext of vscode.extensions.all) {
    if (!isSyncableExtension(ext)) {
      filteredBuiltinCount += 1;
      continue;
    }

    entries.push({
      id: ext.id,
      version: ext.packageJSON?.version ?? "0.0.0",
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id, "en"));

  if (filteredBuiltinCount > 0) {
    getLogger().appendLine(
      `[${new Date().toISOString()}] extensions.json: filtered ${filteredBuiltinCount} builtin/product extension(s)`
    );
  }

  return entries;
}

export function generateExtensionsJson(): string {
  return JSON.stringify(listSyncableExtensionEntries(), null, 2);
}

type DiskExtensionRecord = {
  identifier?: { id?: unknown };
  version?: unknown;
  metadata?: { isBuiltin?: unknown; source?: unknown };
};

/**
 * Cursor's extensions folder is updated as soon as an install finishes.
 * `vscode.extensions.all` keeps the previous package version until reload.
 */
export function entriesFromExtensionManifest(raw: unknown): ExtensionEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byId = new Map<string, ExtensionEntry>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as DiskExtensionRecord;
    if (record.metadata?.isBuiltin === true) {
      continue;
    }
    const id = record.identifier?.id;
    if (typeof id !== "string" || !isInstallCandidateExtensionId(id)) {
      continue;
    }
    const version =
      typeof record.version === "string" && record.version.length > 0
        ? record.version
        : "0.0.0";
    const source = extensionSourceFromMetadata(record.metadata?.source);
    byId.set(id.toLowerCase(), source ? { id, version, source } : { id, version });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}

function readExtensionPackage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\\/g, "/");
  if (!/^vsix\/[A-Za-z0-9][A-Za-z0-9._-]*\.vsix$/i.test(normalized)) {
    return undefined;
  }
  if (normalized.includes("..")) {
    return undefined;
  }
  return normalized;
}

function extensionSourceFromMetadata(
  source: unknown
): "gallery" | "vsix" | undefined {
  if (source === "gallery" || source === "vsix") {
    return source;
  }
  return undefined;
}

/** Disk version and install source win. Host-only ids stay. */
export function mergeInstalledExtensionEntries(
  host: readonly ExtensionEntry[],
  disk: readonly ExtensionEntry[]
): ExtensionEntry[] {
  const byId = new Map<string, ExtensionEntry>();
  for (const entry of host) {
    byId.set(entry.id.toLowerCase(), entry);
  }
  for (const entry of disk) {
    const key = entry.id.toLowerCase();
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, entry);
      continue;
    }
    const next: ExtensionEntry = { id: existing.id, version: entry.version };
    if (entry.source) {
      next.source = entry.source;
    }
    if (entry.package) {
      next.package = entry.package;
    }
    byId.set(key, next);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export async function readInstalledExtensionManifest(
  dotCursor?: string
): Promise<ExtensionEntry[]> {
  const root = dotCursor ?? resolveSyncRoots().dotCursor;
  try {
    const raw = await fs.readFile(
      path.join(root, "extensions", "extensions.json"),
      "utf-8"
    );
    return entriesFromExtensionManifest(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function generateResolvedExtensionsJson(
  dotCursor?: string,
  cursorUser?: string
): Promise<string> {
  const host = listSyncableExtensionEntries();
  const disk = await readInstalledExtensionManifest(dotCursor);
  const annotated = annotateExtensionPackages(
    mergeInstalledExtensionEntries(host, disk)
  );
  const entries = cursorUser
    ? await omitUnpackedVsixPackages(annotated, cursorUser)
    : annotated;
  return JSON.stringify(entries, null, 2);
}

/** Packs local extension folders, then writes extensions.json that only names packages on disk. */
export async function prepareExtensionsJsonForSync(): Promise<string> {
  const { cursorUser, dotCursor } = resolveSyncRoots();
  try {
    await syncPrivateExtensionPackages(cursorUser, dotCursor);
  } catch (err) {
    getLogger().appendLine(
      `[${new Date().toISOString()}] Private extension packages were not updated: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return generateResolvedExtensionsJson(dotCursor, cursorUser);
}

async function omitUnpackedVsixPackages(
  entries: readonly ExtensionEntry[],
  cursorUser: string
): Promise<ExtensionEntry[]> {
  const kept: ExtensionEntry[] = [];
  for (const entry of entries) {
    if (entry.source !== "vsix" || !entry.package) {
      kept.push(entry);
      continue;
    }
    try {
      await fs.access(path.join(cursorUser, ...entry.package.split("/")));
      kept.push(entry);
    } catch {
      kept.push({ id: entry.id, version: entry.version, source: "vsix" });
    }
  }
  return kept;
}

async function writeExtensionsJsonIfChanged(
  filePath: string,
  content: string
): Promise<void> {
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing === content) {
      return;
    }
  } catch {
    // Missing file — write below.
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/** Writes extensions.json when content differs from disk (idempotent). */
export async function writeExtensionsFile(
  cursorUserRoot: string,
  content?: string
): Promise<string> {
  const filePath = path.join(cursorUserRoot, "extensions.json");
  const json = content ?? (await generateResolvedExtensionsJson());
  await writeExtensionsJsonIfChanged(filePath, json);
  return filePath;
}

/** Regenerates extensions.json from installed extensions before checksum/conflict checks. */
export async function ensureExtensionsJsonOnDisk(): Promise<void> {
  const { cursorUser } = resolveSyncRoots();
  const json = await prepareExtensionsJsonForSync();
  await writeExtensionsFile(cursorUser, json);
}

/**
 * Remote entries not present among any installed extension (including builtins).
 * Builtins already on the machine must not be treated as missing installs.
 */
export function findMissingExtensions(
  remoteEntries: ExtensionEntry[],
  diskEntries: readonly ExtensionEntry[] = []
): ExtensionEntry[] {
  const installedVersions = new Map(
    vscode.extensions.all.map((ext) => [
      ext.id.toLowerCase(),
      ext.packageJSON?.version ?? "",
    ])
  );
  const diskVersions = new Map(
    diskEntries.map((entry) => [entry.id.toLowerCase(), entry.version])
  );

  return remoteEntries.filter((entry) => {
    const installed = installedVersions.get(entry.id.toLowerCase());
    if (installed === undefined) {
      return true;
    }
    if (entry.source !== "vsix" || installed === entry.version) {
      return false;
    }
    return diskVersions.get(entry.id.toLowerCase()) !== entry.version;
  });
}

/** Syncable local extensions absent from the remote list (uninstall candidates). */
export function findExtraExtensions(
  remoteEntries: ExtensionEntry[]
): string[] {
  const remoteIds = new Set(
    remoteEntries.map((entry) => entry.id.toLowerCase())
  );
  return vscode.extensions.all
    .filter(isSyncableExtension)
    .map((ext) => ext.id)
    .filter((id) => !remoteIds.has(id.toLowerCase()));
}

export const LAST_REMOTE_EXTENSIONS_STATE_KEY = "cursorSync.lastRemoteExtensions";

const REMOTE_EXTENSIONS_GIST_FILE = "cursor-user--extensions.json";
const CONCURRENT_INSTALLS = 2;

type ExtensionSyncLogger = { appendLine: (value: string) => void };

/** Valid `{ id, version }[]`; non-array or non-object items are rejected. */
export function parseExtensionEntries(raw: unknown): ExtensionEntry[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entries: ExtensionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const id = (item as { id?: unknown }).id;
    const version = (item as { version?: unknown }).version;
    if (typeof id !== "string" || !isValidMarketplaceExtensionId(id)) {
      continue;
    }
    const source = extensionSourceFromMetadata(
      (item as { source?: unknown }).source
    );
    const packagePath = readExtensionPackage(
      (item as { package?: unknown }).package
    );
    const entry: ExtensionEntry = {
      id,
      version: typeof version === "string" && version.length > 0 ? version : "0.0.0",
    };
    if (source) {
      entry.source = source;
    }
    if (source === "vsix" && packagePath) {
      entry.package = packagePath;
    }
    entries.push(entry);
  }
  return entries;
}

export function parseRemoteExtensionsFileContent(
  content: string
): ExtensionEntry[] | undefined {
  try {
    return parseExtensionEntries(JSON.parse(content));
  } catch {
    return undefined;
  }
}

export async function cacheLastRemoteExtensions(
  context: vscode.ExtensionContext,
  entries: ExtensionEntry[]
): Promise<void> {
  await context.globalState.update(LAST_REMOTE_EXTENSIONS_STATE_KEY, entries);
}

export async function clearLastRemoteExtensions(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(LAST_REMOTE_EXTENSIONS_STATE_KEY, undefined);
}

export function readLastRemoteExtensions(
  context: vscode.ExtensionContext
): ExtensionEntry[] {
  return (
    parseExtensionEntries(context.globalState.get(LAST_REMOTE_EXTENSIONS_STATE_KEY)) ??
    []
  );
}

function filterInstallCandidates(
  remoteEntries: ExtensionEntry[],
  logger: ExtensionSyncLogger
): ExtensionEntry[] {
  const allowedPublishers =
    vscode.workspace.getConfiguration("cursorSync").get<string[]>(
      "syncExtensions.allowedPublishers"
    ) ?? [];
  const installCandidates = remoteEntries.filter(
    (entry) =>
      isInstallCandidateExtensionId(entry.id) &&
      isPublisherAllowed(entry.id, allowedPublishers)
  );
  const skippedBuiltinRemote = remoteEntries.length - installCandidates.length;
  if (skippedBuiltinRemote > 0) {
    logger.appendLine(
      `[${new Date().toISOString()}] Skipping ${skippedBuiltinRemote} product/builtin/invalid extension id(s) from remote install list`
    );
  }
  return installCandidates;
}

/** Gallery ids install from the store. VSIX entries install from the synced file only. */
async function resolveExtensionInstallTarget(
  entry: ExtensionEntry
): Promise<string | vscode.Uri | undefined> {
  if (entry.source !== "vsix") {
    return entry.id;
  }
  if (!entry.package) {
    return undefined;
  }
  const absolute = path.join(resolveSyncRoots().cursorUser, ...entry.package.split("/"));
  try {
    await fs.access(absolute);
  } catch {
    return undefined;
  }
  return vscode.Uri.file(absolute);
}

/** Prompt Install/Skip for missing remote extensions; never installs without Install.
 *  When autoInstall is false, skip the prompt entirely.
 */
export async function promptAndInstallMissingExtensions(
  remoteEntries: ExtensionEntry[],
  logger: ExtensionSyncLogger
): Promise<void> {
  const autoInstall =
    vscode.workspace
      .getConfiguration("cursorSync")
      .get<boolean>("syncExtensions.autoInstall") ?? true;
  if (!autoInstall) {
    return;
  }
  if (remoteEntries.length === 0) {
    return;
  }
  const disk = await readInstalledExtensionManifest();
  const missing = findMissingExtensions(
    filterInstallCandidates(remoteEntries, logger),
    disk
  ).filter((entry) => {
    if (entry.source === "vsix" && !entry.package) {
      logger.appendLine(
        `[${new Date().toISOString()}] ${entry.id} is a local package but its synced file is not on disk`
      );
      return false;
    }
    return true;
  });
  if (missing.length === 0) {
    return;
  }
  const names = missing
    .map((entry) =>
      entry.source === "vsix" ? `${entry.id} (synced package)` : entry.id
    )
    .join(", ");
  const choice = await vscode.window.showWarningMessage(
    `Install ${missing.length} extension(s) from the synced list?\n${names}`,
    { modal: true },
    "Install",
    "Skip"
  );
  if (choice !== "Install") {
    return;
  }
  for (let i = 0; i < missing.length; i += CONCURRENT_INSTALLS) {
    const batch = missing.slice(i, i + CONCURRENT_INSTALLS);
    await Promise.all(
      batch.map(async (entry) => {
        try {
          const target = await resolveExtensionInstallTarget(entry);
          if (!target) {
            logger.appendLine(
              `[${new Date().toISOString()}] Synced package for ${entry.id} is not on disk; store install skipped because this extension is not from the gallery`
            );
            return;
          }
          await vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            target
          );
        } catch (err) {
          logger.appendLine(
            `[${new Date().toISOString()}] Failed to install extension ${entry.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );
  }
}

/** Missing-install prompt plus extra-extension uninstall prompt (pull paths). */
export async function syncExtensionsFromRemoteEntries(
  remoteEntries: ExtensionEntry[],
  logger: ExtensionSyncLogger
): Promise<void> {
  await promptAndInstallMissingExtensions(remoteEntries, logger);

  const extras = findExtraExtensions(remoteEntries);
  if (extras.length === 0) {
    return;
  }

  const autoUninstall =
    vscode.workspace
      .getConfiguration("cursorSync")
      .get<boolean>("syncExtensions.autoUninstall") ?? false;
  if (!autoUninstall) {
    return;
  }

  for (const id of extras) {
    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.uninstallExtension",
        id
      );
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Failed to uninstall extension ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Cache the remote extensions list (when parseable) and run missing + extra sync.
 * Callers must skip this when Keep Local is set on extensions.json.
 */
export async function syncExtensionsFromRemoteFiles(
  context: vscode.ExtensionContext,
  remoteFiles: Record<string, string>,
  logger: ExtensionSyncLogger
): Promise<void> {
  const extContent =
    remoteFiles[REMOTE_EXTENSIONS_GIST_FILE] ??
    remoteFiles["cursor-user/extensions.json"];
  if (!extContent) {
    return;
  }
  const entries = parseRemoteExtensionsFileContent(extContent);
  if (entries === undefined) {
    return;
  }
  await cacheLastRemoteExtensions(context, entries);
  await syncExtensionsFromRemoteEntries(entries, logger);
}
