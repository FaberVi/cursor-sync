import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const showQuickPickMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();

const testEnv = { home: "" };

vi.mock("vscode", () => ({
  window: {
    showQuickPick: showQuickPickMock,
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
  },
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testEnv.home };
});

vi.mock("../src/transcripts.js", async () => {
  const path = await import("node:path");
  return {
    __chatPersistenceInternals: {
      resolveChatsRoot: () => path.join(testEnv.home, ".cursor", "chats"),
      querySqliteRows: vi.fn(),
      resolveStateDbCandidates: vi.fn().mockResolvedValue([]),
    },
  };
});

describe("chat-export-ux", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-export-ux-"));
    testEnv.home = tmpRoot;
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

describe("listConversationsForWorkspace labels", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-export-ux-"));
    testEnv.home = tmpRoot;
    chatsRoot = path.join(tmpRoot, ".cursor", "chats");
    await fs.mkdir(chatsRoot, { recursive: true });
    vi.resetModules();
  });

  it("uses composer name when provided in index", async () => {
    const wk = "wk-1";
    const convId = "conv-composer";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const index = new Map([[convId, "Composer Sidebar Name"]]);
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      composerIndex: index,
    });
    expect(rows[0]!.label).toBe("Composer Sidebar Name");
  });

  it("skips skills preamble and uses first user message", async () => {
    const wk = "wk-2";
    const convId = "conv-transcript";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const projectDir = path.join(projectsRoot, "proj-a");
    const transcriptDir = path.join(projectDir, "agent-transcripts", convId);
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcript = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "The user has manually attached the following skills to their message.",
            },
          ],
        },
      }),
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "Real user question here" }],
        },
      }),
    ].join("\n");
    await fs.writeFile(path.join(transcriptDir, `${convId}.jsonl`), transcript, "utf8");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      composerIndex: new Map(),
    });
    expect(rows[0]!.label).toContain("Real user question here");
  });

  it("falls back to conversationId when no title sources", async () => {
    const wk = "wk-3";
    const convId = "only-id";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      composerIndex: new Map(),
    });
    expect(rows[0]!.label).toBe("only-id");
  });
});

describe("pickChatsForExport workspace labels", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-export-ux-"));
    testEnv.home = tmpRoot;
    chatsRoot = path.join(tmpRoot, ".cursor", "chats");
    await fs.mkdir(chatsRoot, { recursive: true });
    vi.resetModules();
  });

  it("shows resolved tilde path in workspace QuickPick label", async () => {
    const { md5FolderKey } = await import("../src/chat-workspace-context.js");
    const folder = path.join(tmpRoot, "dev", "my-app");
    await fs.mkdir(folder, { recursive: true });
    const chatsKey = md5FolderKey(path.resolve(folder));
    await fs.mkdir(path.join(chatsRoot, chatsKey), { recursive: true });
    await fs.mkdir(path.join(chatsRoot, "zzz-other-workspace"), { recursive: true });
    const cursorUser = path.join(tmpRoot, "Cursor", "User");
    const wsDir = path.join(cursorUser, "workspaceStorage", "ws-1");
    await fs.mkdir(wsDir, { recursive: true });
    const { pathToFileURL } = await import("node:url");
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(path.resolve(folder)).href }),
      "utf8"
    );
    vi.doMock("../src/paths.js", () => ({
      resolveSyncRoots: () => ({
        cursorUser,
        dotCursor: path.join(tmpRoot, ".cursor"),
      }),
    }));
    vi.resetModules();
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await pickChatsForExport();
    const firstPickArg = showQuickPickMock.mock.calls[0]![0] as Array<{
      label: string;
      description: string;
    }>;
    expect(firstPickArg[0]!.label).toBe("~/dev/my-app");
    expect(firstPickArg[0]!.description).toBe(chatsKey);
  });
});
