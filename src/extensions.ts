import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveSyncRoots } from "./paths.js";

interface ExtensionEntry {
  id: string;
  version: string;
}

export function generateExtensionsJson(): string {
  const extensions = vscode.extensions.all;
  const entries: ExtensionEntry[] = [];

  for (const ext of extensions) {
    if (ext.id.startsWith("vscode.")) {
      continue;
    }

    const kind = ext.extensionKind;
    if (kind === vscode.ExtensionKind.UI) {
      // ExtensionKind.UI = 1, not builtin
    }

    entries.push({
      id: ext.id,
      version: ext.packageJSON?.version ?? "0.0.0",
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(entries, null, 2);
}

/** Regenerates extensions.json from installed extensions before checksum/conflict checks. */
export async function ensureExtensionsJsonOnDisk(): Promise<void> {
  const { cursorUser } = resolveSyncRoots();
  const filePath = path.join(cursorUser, "extensions.json");
  const content = generateExtensionsJson();
  await fs.mkdir(cursorUser, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

export function findMissingExtensions(
  remoteEntries: ExtensionEntry[]
): ExtensionEntry[] {
  const installedIds = new Set(
    vscode.extensions.all
      .filter((ext) => !ext.id.startsWith("vscode."))
      .map((ext) => ext.id.toLowerCase())
  );

  return remoteEntries.filter(
    (entry) => !installedIds.has(entry.id.toLowerCase())
  );
}

export function findExtraExtensions(
  remoteEntries: ExtensionEntry[]
): string[] {
  const remoteIds = new Set(
    remoteEntries.map((entry) => entry.id.toLowerCase())
  );
  return vscode.extensions.all
    .filter((ext) => !ext.id.startsWith("vscode."))
    .map((ext) => ext.id)
    .filter((id) => !remoteIds.has(id.toLowerCase()));
}
