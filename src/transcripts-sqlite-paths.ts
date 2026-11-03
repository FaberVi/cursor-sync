import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export async function listGlobalStateVscdbPaths(): Promise<string[]> {
  const home = os.homedir();
  const platformGlobal =
    process.platform === "darwin"
      ? [
          path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
          path.join(
            home,
            "Library",
            "Application Support",
            "Cursor Nightly",
            "User",
            "globalStorage",
            "state.vscdb"
          ),
        ]
      : process.platform === "win32"
        ? [
            path.join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
            path.join(
              home,
              "AppData",
              "Roaming",
              "Cursor Nightly",
              "User",
              "globalStorage",
              "state.vscdb"
            ),
          ]
        : [
            path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
            path.join(home, ".config", "Cursor Nightly", "User", "globalStorage", "state.vscdb"),
          ];
  const out: string[] = [];
  for (const candidate of platformGlobal) {
    try {
      await fs.access(candidate);
      out.push(candidate);
    } catch {}
  }
  return out;
}

export async function listWorkspaceStateVscdbPaths(): Promise<string[]> {
  const home = os.homedir();
  const roots =
    process.platform === "darwin"
      ? [
          path.join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
          path.join(home, "Library", "Application Support", "Cursor Nightly", "User", "workspaceStorage"),
        ]
      : process.platform === "win32"
        ? [
            path.join(home, "AppData", "Roaming", "Cursor", "User", "workspaceStorage"),
            path.join(home, "AppData", "Roaming", "Cursor Nightly", "User", "workspaceStorage"),
          ]
        : [
            path.join(home, ".config", "Cursor", "User", "workspaceStorage"),
            path.join(home, ".config", "Cursor Nightly", "User", "workspaceStorage"),
          ];
  const out: string[] = [];
  for (const root of roots) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name, "state.vscdb");
      try {
        await fs.access(p);
        out.push(p);
      } catch {}
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export async function resolveStateDbCandidates(): Promise<string[]> {
  const workspaceDbs = await listWorkspaceStateVscdbPaths();
  const globalDbs = await listGlobalStateVscdbPaths();
  return [...new Set([...workspaceDbs, ...globalDbs])];
}

export async function resolveImportMergeStateDbCandidates(): Promise<string[]> {
  const workspaceDbs = await listWorkspaceStateVscdbPaths();
  const globalDbs = await listGlobalStateVscdbPaths();
  return [...new Set([...globalDbs, ...workspaceDbs])];
}
