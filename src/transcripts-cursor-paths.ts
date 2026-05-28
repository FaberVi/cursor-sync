import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export function resolveChatsRoot(): string {
  return path.join(os.homedir(), ".cursor", "chats");
}

async function storeDbExists(storePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(storePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function findWorkspaceKeysForConversation(
  conversationId: string
): Promise<string[]> {
  let workspaceEntries: import("node:fs").Dirent[];
  try {
    workspaceEntries = await fs.readdir(resolveChatsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory()) continue;
    const storePath = path.join(
      resolveChatsRoot(),
      workspaceEntry.name,
      conversationId,
      "store.db"
    );
    if (await storeDbExists(storePath)) {
      matches.push(workspaceEntry.name);
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

export async function findStoreDbForConversation(
  conversationId: string
): Promise<{ absolutePath: string; workspaceKey: string } | undefined> {
  const workspaceKeys = await findWorkspaceKeysForConversation(conversationId);
  const workspaceKey = workspaceKeys[0];
  if (!workspaceKey) {
    return undefined;
  }
  return {
    absolutePath: path.join(resolveChatsRoot(), workspaceKey, conversationId, "store.db"),
    workspaceKey,
  };
}
