import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const showQuickPickMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();

let mockedHome = "";

vi.mock("vscode", () => ({
  window: {
    showQuickPick: showQuickPickMock,
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
  },
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => mockedHome };
});

describe("chat-export-ux", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-export-ux-"));
    mockedHome = tmpRoot;
    chatsRoot = path.join(tmpRoot, ".cursor", "chats");
    await fs.mkdir(chatsRoot, { recursive: true });
    vi.resetModules();
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
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot);
    expect(rows.map((r) => r.conversationId)).toEqual(["conv-a"]);
  });

  it("returns null when workspace picker dismissed", async () => {
    await fs.mkdir(path.join(chatsRoot, "wk-a"), { recursive: true });
    await fs.mkdir(path.join(chatsRoot, "wk-b"), { recursive: true });
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await expect(pickChatsForExport()).resolves.toBeNull();
  });

  it("returns workspaceKey and conversationIds on success", async () => {
    const wk = "wk-md5";
    await fs.mkdir(path.join(chatsRoot, wk, "conv-1"), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, "conv-1", "store.db"), "x");
    await fs.mkdir(path.join(chatsRoot, wk, "wk-b"), { recursive: true });
    await fs.mkdir(path.join(chatsRoot, "wk-other"), { recursive: true });
    showQuickPickMock
      .mockResolvedValueOnce({ description: wk })
      .mockResolvedValueOnce([{ description: "conv-1" }]);
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await expect(pickChatsForExport()).resolves.toEqual({
      workspaceKey: wk,
      conversationIds: ["conv-1"],
    });
  });
});
