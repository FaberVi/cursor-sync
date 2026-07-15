import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const testEnv = { home: "", workspaceFolders: [] as Array<{ uri: { fsPath: string } }> };

vi.mock("vscode", async () => {
  const base = await import("./__mocks__/vscode.js");
  return {
    ...base,
    workspace: {
      ...base.workspace,
      get workspaceFolders() {
        return testEnv.workspaceFolders.length > 0 ? testEnv.workspaceFolders : undefined;
      },
    },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testEnv.home };
});

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: path.join(testEnv.home, "Cursor", "User"),
    dotCursor: path.join(testEnv.home, ".cursor"),
  }),
}));

vi.mock("../src/transcripts.js", async () => {
  const pathMod = await import("node:path");
  return {
    __chatPersistenceInternals: {
      resolveChatsRoot: () => pathMod.join(testEnv.home, ".cursor", "chats"),
      querySqliteRows: vi.fn().mockResolvedValue([]),
      resolveStateDbCandidates: vi.fn().mockResolvedValue([]),
      listGlobalStateVscdbPaths: vi.fn().mockResolvedValue([]),
    },
  };
});

describe("chat-discovery", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-discovery-"));
    testEnv.home = tmpRoot;
    testEnv.workspaceFolders = [];
    vi.resetModules();
  });

  it("discovers transcript-only conversations without store.db", async () => {
    const convId = "11111111-2222-4333-8444-555555555555";
    const projectKey = "GitHub-Web-cursor-sync";
    const transcriptDir = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      convId
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(path.join(transcriptDir, `${convId}.jsonl`), '{"role":"user"}\n');

    const { discoverAllConversations } = await import("../src/chat-discovery.js");
    const rows = await discoverAllConversations();
    expect(rows.some((r) => r.conversationId === convId)).toBe(true);
    const row = rows.find((r) => r.conversationId === convId);
    expect(row?.sources).toContain("transcript");
    expect(row?.projectKey).toBe(projectKey);
  });

  it("does not attribute project A transcripts to open workspace B without store.db", async () => {
    const convA = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
    const convB = "bbbbbbbb-cccc-4ddd-8eee-bbbbbbbbbbbb";
    const projectA = "c-Users-repo-a";
    const projectB = "c-Users-repo-b";

    for (const [convId, projectKey] of [
      [convA, projectA],
      [convB, projectB],
    ] as const) {
      const transcriptDir = path.join(
        tmpRoot,
        ".cursor",
        "projects",
        projectKey,
        "agent-transcripts",
        convId
      );
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(path.join(transcriptDir, `${convId}.jsonl`), '{"role":"user"}\n');
    }

    const folderB = path.join(tmpRoot, "repo-b");
    await fs.mkdir(folderB, { recursive: true });
    testEnv.workspaceFolders = [{ uri: { fsPath: folderB } }];

    const { discoverConversationsForOpenWorkspace } = await import("../src/chat-discovery.js");
    const rows = await discoverConversationsForOpenWorkspace();
    const ids = rows.map((r) => r.conversationId);
    expect(ids).not.toContain(convA);
  });

  it("discoverConversationsForOpenWorkspace filters by md5 workspace key when store.db exists", async () => {
    const folder = path.join(tmpRoot, "repo-a");
    await fs.mkdir(folder, { recursive: true });
    testEnv.workspaceFolders = [{ uri: { fsPath: folder } }];

    const { md5FolderKey } = await import("../src/chat-workspace-context.js");
    const wk = md5FolderKey(path.resolve(folder));
    const convId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const storeDir = path.join(tmpRoot, ".cursor", "chats", wk, convId);
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(path.join(storeDir, "store.db"), "sqlite");

    const otherWk = "00000000000000000000000000000000";
    const otherDir = path.join(tmpRoot, ".cursor", "chats", otherWk, convId);
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(otherDir, "store.db"), "sqlite");

    const { discoverConversationsForOpenWorkspace } = await import("../src/chat-discovery.js");
    const rows = await discoverConversationsForOpenWorkspace();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceKey).toBe(wk);
  });

  it("discoverConversationsGroupedByProject groups by project folder", async () => {
    const convA = "aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc";
    const convB = "bbbbbbbb-cccc-4ddd-8eee-dddddddddddd";
    const projectA = "c-Users-alpha";
    const projectB = "c-Users-beta";

    for (const [convId, projectKey] of [
      [convA, projectA],
      [convB, projectB],
    ] as const) {
      const transcriptDir = path.join(
        tmpRoot,
        ".cursor",
        "projects",
        projectKey,
        "agent-transcripts",
        convId
      );
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(path.join(transcriptDir, `${convId}.jsonl`), '{"role":"user"}\n');
    }

    const folderA = path.join(tmpRoot, "alpha");
    await fs.mkdir(folderA, { recursive: true });
    testEnv.workspaceFolders = [{ uri: { fsPath: folderA } }];

    const { discoverConversationsGroupedByProject } = await import("../src/chat-discovery.js");
    const groups = await discoverConversationsGroupedByProject();
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const groupA = groups.find((g) => g.conversations.some((c) => c.conversationId === convA));
    const groupB = groups.find((g) => g.conversations.some((c) => c.conversationId === convB));
    expect(groupA?.projectKey).toBe(projectA);
    expect(groupB?.projectKey).toBe(projectB);
    expect(groupA?.conversations.some((c) => c.conversationId === convB)).toBe(false);
  });

  it("grouped discovery excludes header-only transcript folders", async () => {
    const convId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
    const projectKey = "c-Users-only-header";
    const transcriptDir = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      convId
    );
    await fs.mkdir(transcriptDir, { recursive: true });

    const { discoverConversationsGroupedByProject } = await import("../src/chat-discovery.js");
    const groups = await discoverConversationsGroupedByProject();
    const ids = groups.flatMap((g) => g.conversations.map((c) => c.conversationId));
    expect(ids).not.toContain(convId);
  });

  it("grouped discovery marks hasStore when store.db is under a different chats workspace key", async () => {
    const convId = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
    const projectKey = "c-Users-test-project";
    const storeWorkspaceKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const projectWorkspaceKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const transcriptDir = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      convId
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(path.join(transcriptDir, `${convId}.jsonl`), '{"role":"user"}\n');

    const storeDir = path.join(
      tmpRoot,
      ".cursor",
      "chats",
      storeWorkspaceKey,
      convId
    );
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(path.join(storeDir, "store.db"), "sqlite");

    const folderA = path.join(tmpRoot, "repo-a");
    await fs.mkdir(folderA, { recursive: true });
    testEnv.workspaceFolders = [{ uri: { fsPath: folderA } }];

    const { discoverConversationsGroupedByProject } = await import("../src/chat-discovery.js");
    const groups = await discoverConversationsGroupedByProject();
    const row = groups
      .flatMap((g) => g.conversations)
      .find((c) => c.conversationId === convId);
    expect(row).toBeDefined();
    expect(row?.hasStore).toBe(true);
    expect(row?.jsonlCount).toBeGreaterThan(0);
    expect(row?.workspaceKey).toBe(storeWorkspaceKey);
  });
});
