import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const showQuickPickMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();

const testEnv = { home: "" };
const buildChatsKeyToFolderMapMock = vi.hoisted(() =>
  vi.fn<typeof import("../src/chat-workspace-context.js").buildChatsKeyToFolderMap>()
);

vi.mock("../src/chat-workspace-context.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chat-workspace-context.js")>(
    "../src/chat-workspace-context.js"
  );
  return {
    ...actual,
    buildChatsKeyToFolderMap: buildChatsKeyToFolderMapMock,
  };
});

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => {
    const pathMod = require("node:path") as typeof import("node:path");
    return {
      cursorUser: pathMod.join(testEnv.home, "Cursor", "User"),
      dotCursor: pathMod.join(testEnv.home, ".cursor"),
    };
  },
}));

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
      querySqliteRows: vi.fn().mockResolvedValue([]),
      resolveStateDbCandidates: vi.fn().mockResolvedValue([]),
      listGlobalStateVscdbPaths: vi.fn().mockResolvedValue([]),
    },
  };
});

describe("chat-export-ux", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    buildChatsKeyToFolderMapMock.mockResolvedValue(new Map());
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
    const convId = "11111111-2222-4333-8444-555555555555";
    const withStore = path.join(chatsRoot, wk, convId);
    const withoutStore = path.join(chatsRoot, wk, "22222222-3333-4444-8555-666666666666");
    await fs.mkdir(withStore, { recursive: true });
    await fs.mkdir(withoutStore, { recursive: true });
    await fs.writeFile(path.join(withStore, "store.db"), "sqlite", "utf-8");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot);
    expect(rows.map((r) => r.conversationId)).toEqual([convId]);
  });

  it("returns null when workspace picker dismissed", async () => {
    await fs.mkdir(path.join(chatsRoot, "wk-a"), { recursive: true });
    await fs.mkdir(path.join(chatsRoot, "wk-b"), { recursive: true });
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await expect(pickChatsForExport()).resolves.toBeNull();
    expect(showQuickPickMock).not.toHaveBeenCalled();
  });

  it("returns workspaceKey and conversationIds on success", async () => {
    const wk = "wk-md5";
    const convId = "11111111-2222-4333-8444-555555555555";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    showQuickPickMock.mockResolvedValueOnce([{ description: convId }]);
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await expect(pickChatsForExport()).resolves.toEqual({
      workspaceKey: wk,
      conversationIds: [convId],
    });
  });
});

describe("listConversationsForWorkspace labels", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    buildChatsKeyToFolderMapMock.mockResolvedValue(new Map());
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-export-ux-"));
    testEnv.home = tmpRoot;
    chatsRoot = path.join(tmpRoot, ".cursor", "chats");
    await fs.mkdir(chatsRoot, { recursive: true });
    vi.resetModules();
  });

  it("uses composer name when provided in index", async () => {
    const wk = "wk-1";
    const convId = "11111111-2222-4333-8444-555555555555";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const workspaceIndex = new Map([[convId, "Composer Sidebar Name"]]);
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      workspaceIndex,
      globalIndex: new Map(),
    });
    expect(rows[0]!.label).toBe("Composer Sidebar Name");
  });

  it("uses workspace-scoped composer index over global-only wrong name", async () => {
    const wk = "wk-1";
    const convId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const workspaceIndex = new Map([[convId, "Workspace Correct Name"]]);
    const globalIndex = new Map([[convId, "Global Wrong Name"]]);
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      workspaceIndex,
      globalIndex,
    });
    expect(rows[0]!.label).toBe("Workspace Correct Name");
  });

  it("skips skills preamble and uses first user message", async () => {
    const wk = "wk-2";
    const convId = "22222222-3333-4444-8555-666666666666";
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
      workspaceIndex: new Map(),
      globalIndex: new Map(),
    });
    expect(rows[0]!.label).toContain("Real user question here");
  });

  it("falls back to conversationId when no title sources", async () => {
    const wk = "wk-3";
    const convId = "33333333-4444-4555-8666-777777777777";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      workspaceIndex: new Map(),
      globalIndex: new Map(),
    });
    expect(rows[0]!.label).toBe(convId);
  });
});

describe("pickChatsForExport workspace labels", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    buildChatsKeyToFolderMapMock.mockResolvedValue(new Map());
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
    const convId = "44444444-5555-4666-8777-888888888888";
    await fs.mkdir(path.join(chatsRoot, chatsKey, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, chatsKey, convId, "store.db"), "x");
    const otherConv = "55555555-6666-4777-8888-999999999999";
    await fs.mkdir(path.join(chatsRoot, "zzz-other-workspace", otherConv), { recursive: true });
    await fs.writeFile(
      path.join(chatsRoot, "zzz-other-workspace", otherConv, "store.db"),
      "x"
    );
    buildChatsKeyToFolderMapMock.mockResolvedValue(
      new Map([[chatsKey, path.resolve(folder)]])
    );
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await pickChatsForExport();
    const firstPickArg = showQuickPickMock.mock.calls[0]![0] as Array<{
      label: string;
      description: string;
    }>;
    const row = firstPickArg.find((p) => p.description === chatsKey);
    expect(row).toBeDefined();
    expect(row!.label.replace(/\\/g, "/")).toBe("~/dev/my-app");
  });
});
