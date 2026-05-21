import * as os from "node:os";
import * as path from "node:path";

export function formatDisplayPath(folderFsPath: string, homeDir: string = os.homedir()): string {
  const normalized = path.resolve(folderFsPath);
  const home = path.resolve(homeDir);
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (normalized === home) {
    return "~";
  }
  if (normalized.startsWith(homeWithSep)) {
    return "~" + path.sep + normalized.slice(homeWithSep.length);
  }
  return normalized;
}

export function humanWorkspaceLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const last = parts[parts.length - 1]!;
  const withoutHash = last.length === 40 || last.length === 8 ? parts.slice(0, -1) : parts;
  return withoutHash.join("-");
}
