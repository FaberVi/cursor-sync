import * as os from "node:os";
import * as path from "node:path";

function displayPathSeparators(value: string): string {
  return value.split(path.sep).join("/");
}

export function formatDisplayPath(folderFsPath: string, homeDir: string = os.homedir()): string {
  let normalized: string;
  try {
    normalized = path.resolve(folderFsPath);
  } catch {
    return displayPathSeparators(folderFsPath);
  }
  if (/^[A-Za-z]:[\\/][A-Za-z]:/.test(normalized)) {
    return humanWorkspaceLabel(path.basename(folderFsPath));
  }
  const home = path.resolve(homeDir);
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (normalized === home) {
    return "~";
  }
  if (normalized.startsWith(homeWithSep)) {
    return displayPathSeparators("~" + path.sep + normalized.slice(homeWithSep.length));
  }
  return displayPathSeparators(normalized);
}

export function humanWorkspaceLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const last = parts[parts.length - 1]!;
  const withoutHash = last.length === 40 || last.length === 8 ? parts.slice(0, -1) : parts;
  return withoutHash.join("-");
}

/** Decode Cursor's ~/.cursor/projects/<encoded-folder> name into a readable path. */
export function decodeCursorProjectFolderName(folderName: string): string {
  if (/^\d{10,}$/.test(folderName)) {
    return `Workspace ${folderName}`;
  }
  const parts = folderName.split("-");
  const lower = folderName.toLowerCase();
  if (lower.startsWith("c-users-") && parts.length >= 4) {
    const webIdx = parts.findIndex((p, i) => i >= 3 && p.toLowerCase() === "web");
    if (webIdx >= 0 && webIdx < parts.length - 1) {
      return parts.slice(webIdx + 1).join("-");
    }
    const user = parts[2] ?? "user";
    const tail = parts.slice(3).join("/");
    return `~/${user}/${tail}`;
  }
  if (lower.includes("-appdata-local-temp-")) {
    const uuidMatch = folderName.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    if (uuidMatch) {
      return `Temp session · ${uuidMatch[0].slice(0, 8)}`;
    }
    return "Temp session";
  }
  if (lower === "empty-window" || lower === "ext-dev") {
    return folderName;
  }
  return humanWorkspaceLabel(folderName);
}

export function projectGroupSidebarLabel(
  projectFolderName: string,
  folderMap: Map<string, string>,
  homeDir?: string
): { label: string; pathHint?: string } {
  const decoded = decodeCursorProjectFolderName(projectFolderName);
  const folderFsPath = resolveFolderForProjectDir(projectFolderName, folderMap);
  if (!folderFsPath) {
    return { label: decoded };
  }
  const pathHint = formatDisplayPath(folderFsPath, homeDir);
  if (pathHint.includes(":/") && pathHint.includes("C:/c:")) {
    return { label: decoded };
  }
  if (pathHint === decoded || pathHint.replace(/\\/g, "/") === decoded) {
    return { label: decoded };
  }
  if (/[A-Za-z]:[\\/][A-Za-z]:/.test(pathHint)) {
    return { label: decoded };
  }
  return { label: decoded, pathHint };
}

function resolveFolderForProjectDir(
  projectFolderName: string,
  map: Map<string, string>
): string | undefined {
  const label = humanWorkspaceLabel(projectFolderName).toLowerCase();
  let best: { folderFsPath: string; score: number } | undefined;
  for (const folderFsPath of map.values()) {
    const base = path.basename(folderFsPath).toLowerCase();
    if (base === label) {
      return folderFsPath;
    }
    const folderLabel = humanWorkspaceLabel(path.basename(folderFsPath)).toLowerCase();
    if (folderLabel === label) {
      return folderFsPath;
    }
    const projectLower = projectFolderName.toLowerCase();
    let score = 0;
    if (projectLower.endsWith("-" + base) || projectLower.endsWith(base)) {
      score = 3;
    } else if (base.length >= 4 && projectLower.includes("-" + base)) {
      score = 2;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { folderFsPath, score };
    }
  }
  return best?.folderFsPath;
}

export function workspaceQuickPickLabel(
  chatsKey: string,
  map: Map<string, string>,
  homeDir?: string
): { label: string; description: string } {
  const folderFsPath = map.get(chatsKey);
  if (folderFsPath) {
    return {
      label: formatDisplayPath(folderFsPath, homeDir),
      description: chatsKey,
    };
  }
  return {
    label: humanWorkspaceLabel(chatsKey),
    description: chatsKey,
  };
}

export function projectQuickPickLabel(
  projectFolderName: string,
  map: Map<string, string>,
  homeDir?: string
): string {
  return projectGroupSidebarLabel(projectFolderName, map, homeDir).label;
}
