import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export function resolveChatsRoot(): string {
  return path.join(os.homedir(), ".cursor", "chats");
}

export async function findStoreDbForConversation(
  conversationId: string
): Promise<{ absolutePath: string; workspaceKey: string } | undefined> {
  let workspaceEntries: import("node:fs").Dirent[];
  try {
    workspaceEntries = await fs.readdir(resolveChatsRoot(), { withFileTypes: true });
  } catch {
    return undefined;
  }

  const sortedWorkspaceEntries = workspaceEntries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const workspaceEntry of sortedWorkspaceEntries) {
    const candidate = path.join(resolveChatsRoot(), workspaceEntry.name, conversationId, "store.db");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return {
          absolutePath: candidate,
          workspaceKey: workspaceEntry.name,
        };
      }
    } catch {}
  }

  return undefined;
}
