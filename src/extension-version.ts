import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as vscode from "vscode";

let cachedExtensionVersion: string | undefined;

function readVersionFromPackageJson(packageJsonPath: string): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: string;
    };
    return typeof packageJson.version === "string" && packageJson.version.length > 0
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

/** Installed extension version (sidebar badge, debug prompts). Prefers on-disk package.json. */
export function readExtensionVersion(
  context?: vscode.ExtensionContext
): string {
  if (context?.extensionPath) {
    const fromDisk = readVersionFromPackageJson(
      join(context.extensionPath, "package.json")
    );
    if (fromDisk) {
      return fromDisk;
    }
    const fromContext = context.extension?.packageJSON?.version;
    if (typeof fromContext === "string" && fromContext.length > 0) {
      return fromContext;
    }
  }

  if (cachedExtensionVersion !== undefined) {
    return cachedExtensionVersion;
  }

  const fromBundled = readVersionFromPackageJson(join(__dirname, "..", "package.json"));
  cachedExtensionVersion = fromBundled ?? "unknown";
  return cachedExtensionVersion;
}
