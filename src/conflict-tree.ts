import type { ConflictEntry, ConflictResolution } from "./types.js";

export type ConflictTreeFile = {
  type: "file";
  entry: ConflictEntry;
};

export type ConflictTreeFolder = {
  type: "folder";
  /** Sync key path for this folder, e.g. `dot-cursor/skills/foo`. */
  syncKeyPrefix: string;
  /** Last path segment for display. */
  name: string;
  children: ConflictTreeNode[];
};

export type ConflictTreeNode = ConflictTreeFile | ConflictTreeFolder;

export type FolderPickState = "unset" | "local" | "remote" | "mixed";

export function descendantConflictKeys(
  conflicts: readonly ConflictEntry[],
  folderPrefix: string
): string[] {
  if (!folderPrefix) {
    return conflicts.map((row) => row.relativeSyncKey);
  }
  const needle = `${folderPrefix}/`;
  return conflicts
    .filter(
      (row) =>
        row.relativeSyncKey === folderPrefix ||
        row.relativeSyncKey.startsWith(needle)
    )
    .map((row) => row.relativeSyncKey);
}

export function folderPickState(
  conflicts: readonly ConflictEntry[],
  resolutions: Readonly<Record<string, ConflictResolution | undefined>>,
  folderPrefix: string
): FolderPickState {
  const keys = descendantConflictKeys(conflicts, folderPrefix);
  if (keys.length === 0) {
    return "unset";
  }
  let hasLocal = false;
  let hasRemote = false;
  let hasUnset = false;
  for (const key of keys) {
    const chosen = resolutions[key];
    if (chosen === "keepLocal") {
      hasLocal = true;
    } else if (chosen === "keepRemote") {
      hasRemote = true;
    } else {
      hasUnset = true;
    }
  }
  if (!hasUnset && hasLocal && !hasRemote) {
    return "local";
  }
  if (!hasUnset && hasRemote && !hasLocal) {
    return "remote";
  }
  if (!hasLocal && !hasRemote && hasUnset) {
    return "unset";
  }
  return "mixed";
}

export function buildConflictTree(
  conflicts: readonly ConflictEntry[]
): ConflictTreeFolder {
  const root: ConflictTreeFolder = {
    type: "folder",
    syncKeyPrefix: "",
    name: "",
    children: [],
  };
  const sorted = [...conflicts].sort((a, b) =>
    a.relativeSyncKey.localeCompare(b.relativeSyncKey)
  );
  for (const entry of sorted) {
    const parts = entry.relativeSyncKey.split("/");
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join("/");
      const segment = parts[i]!;
      let child = current.children.find(
        (node): node is ConflictTreeFolder =>
          node.type === "folder" && node.syncKeyPrefix === prefix
      );
      if (!child) {
        child = {
          type: "folder",
          syncKeyPrefix: prefix,
          name: segment,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
    current.children.push({ type: "file", entry });
  }
  sortTreeChildren(root);
  return root;
}

function sortTreeChildren(folder: ConflictTreeFolder): void {
  for (const child of folder.children) {
    if (child.type === "folder") {
      sortTreeChildren(child);
    }
  }
  folder.children.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    const nameA = a.type === "folder" ? a.name : a.entry.relativeSyncKey;
    const nameB = b.type === "folder" ? b.name : b.entry.relativeSyncKey;
    return nameA.localeCompare(nameB);
  });
}

export function applyResolutionToFolder(
  conflicts: readonly ConflictEntry[],
  resolutions: Record<string, ConflictResolution | undefined>,
  folderPrefix: string,
  resolution: ConflictResolution
): void {
  for (const key of descendantConflictKeys(conflicts, folderPrefix)) {
    resolutions[key] = resolution;
  }
}
