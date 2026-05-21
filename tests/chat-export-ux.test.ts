import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("chat-export-ux disk helpers", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-export-ux-"));
    chatsRoot = path.join(tmpRoot, "chats");
    await fs.mkdir(chatsRoot, { recursive: true });
  });

  it("listChatsWorkspaceDirs returns sorted workspace dirs", async () => {
    await fs.mkdir(path.join(chatsRoot, "bbb-wk"), { recursive: true });
    await fs.mkdir(path.join(chatsRoot, "aaa-wk"), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, "file.txt"), "");
    const { listChatsWorkspaceDirs } = await import("../src/chat-export-ux.js");
    const dirs = await listChatsWorkspaceDirs(chatsRoot);
    expect(dirs.map((d) => d.name)).toEqual(["aaa-wk", "bbb-wk"]);
    expect(dirs[0]!.fullPath).toBe(path.join(chatsRoot, "aaa-wk"));
  });

  it("listConversationsForWorkspace includes dirs with store.db only", async () => {
    const wk = "workspace-md5";
    const withStore = path.join(chatsRoot, wk, "conv-a");
    const withoutStore = path.join(chatsRoot, wk, "conv-b");
    await fs.mkdir(withStore, { recursive: true });
    await fs.mkdir(withoutStore, { recursive: true });
    await fs.writeFile(path.join(withStore, "store.db"), "sqlite", "utf-8");
    const projectsRoot = path.join(tmpRoot, "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot);
    expect(rows.map((r) => r.conversationId)).toEqual(["conv-a"]);
  });
});
