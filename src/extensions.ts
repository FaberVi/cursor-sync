import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { resolveSyncRoots } from "./paths.js";

export interface ExtensionEntry {
  id: string;
  version: string;
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
  const json = content ?? generateExtensionsJson();
  await writeExtensionsJsonIfChanged(filePath, json);
  return filePath;
}

/** Regenerates extensions.json from installed extensions before checksum/conflict checks. */
export async function ensureExtensionsJsonOnDisk(): Promise<void> {
  const { cursorUser } = resolveSyncRoots();
  await writeExtensionsFile(cursorUser);
}

/**
 * Remote entries not present among any installed extension (including builtins).
 * Builtins already on the machine must not be treated as missing installs.
 */
export function findMissingExtensions(
  remoteEntries: ExtensionEntry[]
): ExtensionEntry[] {
  const installedIds = new Set(
    vscode.extensions.all.map((ext) => ext.id.toLowerCase())
  );

  return remoteEntries.filter(
    (entry) => !installedIds.has(entry.id.toLowerCase())
  );
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
