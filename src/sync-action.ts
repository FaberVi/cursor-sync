import type { GitRelation } from "./sync-clone.js";

export type SyncActionKind = "none" | "pull" | "push" | "error";

export type SyncAction =
  | { action: "none" }
  | { action: "pull" }
  | { action: "push" }
  | { action: "error"; reason: string };

/**
 * Read-only decision table (no copy into the clone).
 * `cursorDiffers` compares enumerateSyncFiles hashes to nested clone files
 * (chat uses fingerprint vs clone cursor-chat.json).
 */
export function decideSyncAction(input: {
  relation: GitRelation;
  cursorDiffers: boolean;
  completedFileSync: boolean;
  hasNestedRemoteFiles: boolean;
}): SyncAction {
  if (input.relation === "diverged") {
    return { action: "error", reason: "diverged" };
  }
  if (input.relation === "behind") {
    return { action: "pull" };
  }
  if (input.relation === "ahead") {
    return { action: "push" };
  }
  if (input.relation === "empty") {
    return { action: "push" };
  }

  // equal
  if (!input.cursorDiffers) {
    return { action: "none" };
  }
  if (!input.completedFileSync && input.hasNestedRemoteFiles) {
    return { action: "pull" };
  }
  return { action: "push" };
}
