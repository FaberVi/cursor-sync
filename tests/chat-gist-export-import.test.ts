import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
} from "../src/transcript-bundle.js";
import type { ChatBundle } from "../src/chat-persistence.js";

const CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json";
const CHAT_BUNDLES_GIST_FILE_NAME = "chat-bundles.json";

const createGistMock = vi.fn();
const getGistMock = vi.fn();
const requireTokenMock = vi.fn();
const getTokenMock = vi.fn();
const withRetryMock = vi.fn(async <T>(fn: () => Promise<T>) => fn());
const appendLineMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInputBoxMock = vi.fn();
const showQuickPickMock = vi.fn();
const clipboardWriteTextMock = vi.fn();
let mockedHomeDir = "";
let mockWorkspaceFolder = "";

const mockRunDiskAndActivationVerify = vi.hoisted(() =>
  vi.fn(async () => [{ name: "store.db", status: "OK" as const, detail: "mock ok" }])
);

const configurationValues: Record<string, unknown> = {
  "transcripts.autoReloadAfterImport": false,
  "chatImport.activateDefault": false,
  "chatImport.activateStrict": false,
  "chatImport.bridgeWaitResultSeconds": 0,
  "chatImport.pingServer": false,
};

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockedHomeDir,
  };
});

vi.mock("../src/chat-import-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-import-verify.js")>();
  return {
    ...actual,
    runDiskAndActivationVerify: mockRunDiskAndActivationVerify,
  };
});

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return [
        {
          uri: { fsPath: mockWorkspaceFolder, scheme: "file" },
          name: "workspace",
          index: 0,
        },
      ];
    },
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
      update: vi.fn(),
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: appendLineMock,
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: showInformationMessageMock,
    showErrorMessage: showErrorMessageMock,
    showInputBox: showInputBoxMock,
    showQuickPick: showQuickPickMock,
    withProgress: async (
      _options: unknown,
      task: (progress: { report: (value: { message?: string; increment?: number }) => void }) => Promise<unknown>
    ) => task({ report: vi.fn() }),
  },
  env: {
    clipboard: {
      writeText: clipboardWriteTextMock,
    },
  },
  commands: {
    executeCommand: vi.fn(),
  },
  ProgressLocation: {
    Notification: 15,
  },
  ConfigurationTarget: {
    Global: 1,
  },
}));

vi.mock("../src/gist.js", () => ({
  GistClient: class {
    createGist = createGistMock;
    getGist = getGistMock;
  },
}));

vi.mock("../src/auth.js", () => ({
  requireToken: requireTokenMock,
  getToken: getTokenMock,
}));

vi.mock("../src/retry.js", () => ({
  withRetry: withRetryMock,
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const transcriptFixture = readFileSync(
  path.join(testsDir, "fixtures", "transcripts-bundle-v2", "conversation.jsonl"),
  "utf-8"
);

function buildChatBundleFixture(options: {
  conversationId: string;
  projectKey: string;
  transcriptContent?: string;
  type?: string;
  schemaVersion?: number;
}): ChatBundle {
  const {
    conversationId,
    projectKey,
    transcriptContent = transcriptFixture,
    type = "chat-persistence",
    schemaVersion = 1,
  } = options;
  const contentBuf = Buffer.from(transcriptContent);
  const encoded = encodeTranscriptArtifact(contentBuf);
  const checksum = computeArtifactChecksum(contentBuf);

  return {
    schemaVersion: schemaVersion as 1,
    type: type as "chat-persistence",
    createdAt: "2026-05-20T12:00:00.000Z",
    conversationId,
    title: "Test Chat",
    subtitle: "1 file",
    previewText: "Test Chat",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [
      {
        relativePath: `${projectKey}/agent-transcripts/${conversationId}/${conversationId}.jsonl`,
        content: encoded.content,
        encoding: encoded.encoding,
        checksum,
        sizeBytes: contentBuf.length,
      },
    ],
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mockExportPicker(workspaceKey: string, conversationIds: string[]) {
  showQuickPickMock.mockResolvedValueOnce(
    conversationIds.map((id) => ({ description: id, label: id }))
  );
}

async function setupExportConversation(
  root: string,
  workspaceKey: string,
  conversationId: string,
  options?: { projectKey?: string; transcriptContent?: string }
): Promise<void> {
  await fs.mkdir(
    path.join(root, ".cursor", "chats", workspaceKey, conversationId),
    { recursive: true }
  );
  await fs.writeFile(
    path.join(root, ".cursor", "chats", workspaceKey, conversationId, "store.db"),
    "sqlite",
    "utf-8"
  );
  if (options?.projectKey) {
    const transcriptPath = path.join(
      root,
      ".cursor",
      "projects",
      options.projectKey,
      "agent-transcripts",
      conversationId,
      `${conversationId}.jsonl`
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, options.transcriptContent ?? transcriptFixture, "utf-8");
  }
}

describe("chat gist export and import", () => {
  let tmpRoot: string;
  let extensionContext: { globalStorageUri: { fsPath: string } };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-chat-gist-"));
    mockedHomeDir = tmpRoot;
    mockWorkspaceFolder = path.join(tmpRoot, "workspace-repo");
    await fs.mkdir(mockWorkspaceFolder, { recursive: true });
    mockRunDiskAndActivationVerify.mockReset();
    mockRunDiskAndActivationVerify.mockResolvedValue([
      { name: "store.db", status: "OK", detail: "mock ok" },
    ]);
    createGistMock.mockReset();
    getGistMock.mockReset();
    requireTokenMock.mockReset();
    getTokenMock.mockReset();
    withRetryMock.mockClear();
    appendLineMock.mockReset();
    showInformationMessageMock.mockReset();
    showErrorMessageMock.mockReset();
    showInputBoxMock.mockReset();
    showQuickPickMock.mockReset();
    clipboardWriteTextMock.mockReset();
    configurationValues["transcripts.autoReloadAfterImport"] = false;
    requireTokenMock.mockResolvedValue("ghp_chat_export_token");
    getTokenMock.mockResolvedValue("ghp_chat_import_token");
    extensionContext = {
      globalStorageUri: {
        fsPath: path.join(tmpRoot, ".cursor-sync-global-storage"),
      },
    };
    await fs.mkdir(extensionContext.globalStorageUri.fsPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("exports chat bundle to private gist with chat-bundle.json only", async () => {
    const workspaceKey = "chat-export-wk";
    const projectKey = "chat-export-project";
    const conversationId = "conv-gist-export-001";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId, {
      projectKey,
    });
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue("Copy URL");
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-chat-export",
        html_url: "https://gist.github.com/example/gist-chat-export",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    const [gistFiles, description] = createGistMock.mock.calls[0] as [
      Record<string, { content: string }>,
      string,
    ];
    expect(Object.keys(gistFiles)).toEqual([CHAT_BUNDLE_GIST_FILE_NAME]);
    expect(description).toBe("Cursor Sync - Chat Export");
    expect(createGistMock.mock.calls[0]).toHaveLength(2);

    const bundle = JSON.parse(gistFiles[CHAT_BUNDLE_GIST_FILE_NAME].content) as ChatBundle;
    expect(bundle.type).toBe("chat-persistence");
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.conversationId).toBe(conversationId);
    expect(bundle.transcriptFiles).toHaveLength(1);
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "https://gist.github.com/example/gist-chat-export"
    );
  });

  it("calls createGist with two arguments only (no public flag)", async () => {
    const workspaceKey = "chat-two-arg-wk";
    const projectKey = "chat-two-arg-project";
    const conversationId = "conv-two-arg-001";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId, {
      projectKey,
    });
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-two-arg",
        html_url: "https://gist.github.com/example/gist-two-arg",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    expect(createGistMock.mock.calls[0]).toHaveLength(2);
    expect(createGistMock.mock.calls[0]![2]).toBeUndefined();
  });

  it("imports valid chat bundle and calls restoreChatBundle", async () => {
    const sourceProjectKey = "source-chat-project";
    const targetProjectKey = "target-chat-project";
    const conversationId = "conv-gist-import-001";
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);
    await fs.mkdir(targetProjectDir, { recursive: true });

    const bundle = buildChatBundleFixture({
      conversationId,
      projectKey: sourceProjectKey,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-chat-import",
        html_url: "https://gist.github.com/example/gist-chat-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: {
            content: JSON.stringify(bundle, null, 2),
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-chat-import");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) => {
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) {
          return activateItem;
        }
        return items.find((item) => item.description === targetProjectKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    const [, restoredBundle, , restoreOptions] = restoreSpy.mock.calls[0]!;
    expect(restoredBundle.conversationId).toBe(conversationId);
    expect(restoreOptions?.workspaceFolder).toBe(mockWorkspaceFolder);
    expect(restoredBundle.type).toBe("chat-persistence");

    const importedPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      conversationId,
      `${conversationId}.jsonl`
    );
    expect(await fs.readFile(importedPath, "utf-8")).toBe(transcriptFixture);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes(`Chat "${conversationId}" loaded.`)
      )
    ).toBe(true);

    restoreSpy.mockRestore();
  });

  it("round-trips export gist bundle through import restore", async () => {
    const workspaceKey = "roundtrip-wk";
    const projectKey = "roundtrip-project";
    const conversationId = "conv-roundtrip-001";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId, {
      projectKey,
    });

    let exportedBundleJson = "";
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockImplementation(async (gistFiles: Record<string, { content: string }>) => {
      exportedBundleJson = gistFiles[CHAT_BUNDLE_GIST_FILE_NAME].content;
      return {
        ok: true,
        data: {
          id: "gist-roundtrip",
          html_url: "https://gist.github.com/example/gist-roundtrip",
          description: "Cursor Sync - Chat Export",
          files: {},
          created_at: "2026-05-20T12:00:00.000Z",
          updated_at: "2026-05-20T12:00:00.000Z",
        },
      };
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(exportedBundleJson).not.toBe("");
    const exportedBundle = JSON.parse(exportedBundleJson) as ChatBundle;

    const importTargetKey = "roundtrip-target";
    const importTargetDir = path.join(tmpRoot, ".cursor", "projects", importTargetKey);
    await fs.mkdir(importTargetDir, { recursive: true });
    await fs.rm(
      path.join(
        tmpRoot,
        ".cursor",
        "projects",
        projectKey,
        "agent-transcripts",
        conversationId,
        `${conversationId}.jsonl`
      ),
      { force: true }
    );

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-roundtrip",
        html_url: "https://gist.github.com/example/gist-roundtrip",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: exportedBundleJson },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValueOnce("https://gist.github.com/user/gist-roundtrip");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) => {
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) {
          return activateItem;
        }
        return items.find((item) => item.description === importTargetKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    const importedPath = path.join(
      importTargetDir,
      "agent-transcripts",
      exportedBundle.conversationId,
      `${exportedBundle.conversationId}.jsonl`
    );
    expect(await fs.readFile(importedPath, "utf-8")).toBe(transcriptFixture);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
  });

  it("rejects gist missing chat-bundle.json", async () => {
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-no-bundle",
        html_url: "https://gist.github.com/example/gist-no-bundle",
        description: "empty",
        files: {
          "readme.md": { content: "not a chat export" },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-no-bundle");

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Gist chat import failed: Gist does not contain chat-bundle.json. Export a chat with Cursor Sync: Export Chat to Private Gist first."
    );
    restoreSpy.mockRestore();
  });

  it("rejects gist with transcript manifest instead of chat bundle", async () => {
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-transcript-only",
        html_url: "https://gist.github.com/example/gist-transcript-only",
        description: "transcripts",
        files: {
          "transcript-manifest.json": { content: "{}" },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-transcript-only");

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Gist chat import failed: Gist does not contain a chat bundle (chat-bundle.json). This Gist is an agent transcript export. Use Cursor Sync: Import Agent Transcripts from Private Gist."
    );
    restoreSpy.mockRestore();
  });

  it("rejects gist with wrong chat bundle type", async () => {
    const bundle = buildChatBundleFixture({
      conversationId: "conv-wrong-type",
      projectKey: "wrong-type-project",
      type: "agent-transcripts",
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-wrong-type",
        html_url: "https://gist.github.com/example/gist-wrong-type",
        description: "wrong",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: JSON.stringify(bundle) },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-wrong-type");

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      'Gist chat import failed: Invalid chat bundle: expected type "chat-persistence", got "agent-transcripts".'
    );
    restoreSpy.mockRestore();
  });

  it("exports multiple chats to chat-bundles.json", async () => {
    const workspaceKey = "multi-export-wk";
    const id1 = "conv-multi-001";
    const id2 = "conv-multi-002";
    await setupExportConversation(tmpRoot, workspaceKey, id1);
    await setupExportConversation(tmpRoot, workspaceKey, id2);
    mockExportPicker(workspaceKey, [id1, id2]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-multi-export",
        html_url: "https://gist.github.com/example/gist-multi-export",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    const [gistFiles] = createGistMock.mock.calls[0] as [
      Record<string, { content: string }>,
      string,
    ];
    expect(Object.keys(gistFiles)).toEqual([CHAT_BUNDLES_GIST_FILE_NAME]);
    const collection = JSON.parse(gistFiles[CHAT_BUNDLES_GIST_FILE_NAME].content) as {
      type: string;
      bundles: unknown[];
    };
    expect(collection.type).toBe("chat-bundles-collection");
    expect(collection.bundles).toHaveLength(2);
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("2 chats in private Gist")
      )
    ).toBe(true);
  });
});
