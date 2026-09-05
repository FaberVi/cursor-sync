import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const showQuickPickMock = vi.fn();
const testEnv = { home: "", cursorUser: "" };
const folderMapHolder = vi.hoisted(() => ({ map: new Map<string, string>() }));

vi.mock("vscode", async () => {
  const base = await import("./__mocks__/vscode.js");
  return {
    ...base,
    window: { ...base.window, showQuickPick: showQuickPickMock, showErrorMessage: vi.fn() },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testEnv.home };
});

vi.mock("../src/chat-workspace-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-workspace-context.js")>();
  return {
    ...actual,
    buildChatsKeyToFolderMap: async () => folderMapHolder.map,
  };
});

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  return {
    ...actual,
    resolveSyncRoots: () => ({
      cursorUser: testEnv.cursorUser || path.join(testEnv.home, "Cursor", "User"),
      dotCursor: path.join(testEnv.home, ".cursor"),
    }),
  };
});

vi.mock("../src/transcripts.js", async () => {
  const pathMod = await import("node:path");
  return {
    __chatPersistenceInternals: {
      resolveChatsRoot: () => pathMod.join(testEnv.home, ".cursor", "chats"),
      querySqliteRows: vi.fn(),
      resolveStateDbCandidates: vi.fn().mockResolvedValue([]),
      findStoreDbForConversation: vi.fn(),
      isExecFileTimeoutError: vi.fn(() => false),
    },
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: vi.fn(),
  rollbackFromBackup: vi.fn(),
  pruneOldBackups: vi.fn(),
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
}));

describe("chat persistence project picker labels", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    folderMapHolder.map = new Map();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-persistence-labels-"));
    testEnv.home = tmpRoot;
    vi.resetModules();
  });

  it("promptForTargetProject uses projectQuickPickLabel for local rows", async () => {
    const folder = path.join(tmpRoot, "dev", "cursor-sync");
    await fs.mkdir(folder, { recursive: true });
    const cursorUser = path.join(tmpRoot, "Cursor", "User");
    testEnv.cursorUser = cursorUser;
    const wsDir = path.join(cursorUser, "workspaceStorage", "id1");
    await fs.mkdir(wsDir, { recursive: true });
    const { pathToFileURL } = await import("node:url");
    const { createHash } = await import("node:crypto");
    const resolvedFolder = path.resolve(folder);
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(resolvedFolder).href }),
      "utf8"
    );
    folderMapHolder.map = new Map([
      [createHash("md5").update(resolvedFolder, "utf8").digest("hex"), resolvedFolder],
    ]);

    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const projectDirName = "home-user-dev-cursor-sync-abcdef12";
    await fs.mkdir(path.join(projectsRoot, projectDirName), { recursive: true });

    showQuickPickMock.mockResolvedValueOnce({ description: "skip" });

    const { __chatPersistenceTestUtils } = await import("../src/chat-persistence.js");
    await __chatPersistenceTestUtils.promptForTargetProject(["source-key-abcdef12"]);

    const picks = showQuickPickMock.mock.calls[0]![0] as Array<{
      label: string;
      description: string;
    }>;
    const localRow = picks.find((p) => p.description !== "skip");
    expect(localRow!.label).toBe("~/dev/cursor-sync");
    expect(localRow!.description).toBe(projectDirName);
  });
});
