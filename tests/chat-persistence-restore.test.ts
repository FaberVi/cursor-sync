import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
  decodeTranscriptArtifact,
} from "../src/transcript-bundle.js";
import { md5FolderKey } from "../src/chat-workspace-context.js";
import type { ChatBundle } from "../src/chat-persistence.js";

const FIXTURE_REPO = "/tmp/cursor-sync-fixture-repo";

const mockHomedir = vi.hoisted(() => ({ home: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.home ?? actual.homedir(),
  };
});

const mockWorkspaceFolders = vi.hoisted(() => [
  {
    uri: { fsPath: "/tmp/cursor-sync-fixture-repo", scheme: "file" },
    name: "fixture",
    index: 0,
  },
]);

vi.mock("vscode", async () => {
  const base = await import("./__mocks__/vscode.js");
  return {
    ...base,
    workspace: {
      ...base.workspace,
      get workspaceFolders() {
        return mockWorkspaceFolders;
      },
    },
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: vi.fn(async () => ({ backupDir: "", entries: [] })),
  rollbackFromBackup: vi.fn(async () => {}),
  pruneOldBackups: vi.fn(async () => {}),
}));

const { mockResolveTransportChatScript, mockRunPythonDiskImport } = vi.hoisted(() => ({
  mockResolveTransportChatScript: vi.fn(async () => "/fake/cursor_chat_io.py"),
  mockRunPythonDiskImport: vi.fn(async () => ({
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
  })),
}));

vi.mock("../src/chat-transport-scripts.js", () => ({
  resolveTransportChatScript: mockResolveTransportChatScript,
  runPythonDiskImport: mockRunPythonDiskImport,
}));

const mockRunDiskAndActivationVerify = vi.hoisted(() =>
  vi.fn(async () => [{ name: "store.db", status: "OK" as const, detail: "mock ok" }])
);

const mockVerifyActivationChecks = vi.hoisted(() =>
  vi.fn(async () => [
    { name: "activation.status", status: "OK" as const, detail: "completed" },
  ])
);

vi.mock("../src/chat-import-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-import-verify.js")>();
  return {
    ...actual,
    runDiskAndActivationVerify: mockRunDiskAndActivationVerify,
    verifyActivationChecks: mockVerifyActivationChecks,
  };
});

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
}));

describe("restoreChatBundle disk parity", () => {
  let tempHome: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-restore-"));
    savedHome = process.env.HOME;
    process.env.HOME = tempHome;
    mockHomedir.home = tempHome;
    mockRunDiskAndActivationVerify.mockReset();
    mockRunDiskAndActivationVerify.mockResolvedValue([
      { name: "store.db", status: "OK", detail: "mock ok" },
    ]);
    mockResolveTransportChatScript.mockReset();
    mockResolveTransportChatScript.mockResolvedValue("/fake/cursor_chat_io.py");
    mockRunPythonDiskImport.mockReset();
    mockRunPythonDiskImport.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "" });
    mockWorkspaceFolders.length = 0;
    mockWorkspaceFolders.push({
      uri: { fsPath: FIXTURE_REPO, scheme: "file" },
      name: "fixture",
      index: 0,
    });
  });

  afterEach(async () => {
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    mockHomedir.home = undefined;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("writes store.db under md5(workspace folder) chats key", async () => {
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const storeBytes = Buffer.from("SQLite format 3\0test-store");
    const encoded = encodeTranscriptArtifact(storeBytes, true);
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId: "conv-store-md5",
      title: "Store test",
      subtitle: "",
      previewText: "Store test",
      sidebarSnapshot: null,
      storeSnapshot: {
        content: encoded.content,
        encoding: encoded.encoding,
        checksum: computeArtifactChecksum(storeBytes),
        sizeBytes: storeBytes.length,
        sourceWorkspaceKey: "must-not-use-this-key",
      },
      transcriptFiles: [],
    };

    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as import("vscode").ExtensionContext;

    const result = await restoreChatBundle(context, bundle, {
      report: () => {},
    });

    const chatsKey = md5FolderKey(path.resolve(FIXTURE_REPO));
    expect(result.storeWritten).toBe(true);
    expect(result.storeWorkspaceKey).toBe(chatsKey);
    expect(chatsKey).not.toBe("must-not-use-this-key");
  });

  it("throws when disk import fails (Python reports failure)", async () => {
    mockRunPythonDiskImport.mockResolvedValueOnce({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "checksum mismatch",
    });
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const storeBytes = Buffer.from("valid");
    const encoded = encodeTranscriptArtifact(storeBytes, true);
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId: "conv-bad-checksum",
      title: "Bad",
      subtitle: "",
      previewText: "Bad",
      sidebarSnapshot: null,
      storeSnapshot: {
        content: encoded.content,
        encoding: encoded.encoding,
        checksum: "deadbeef",
        sizeBytes: storeBytes.length,
        sourceWorkspaceKey: "ignored",
      },
      transcriptFiles: [],
    };

    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as import("vscode").ExtensionContext;

    await expect(
      restoreChatBundle(context, bundle, { report: () => {} })
    ).rejects.toThrow(/Disk import failed/);
  });

  it("throws when transport-chat scripts are not found", async () => {
    mockResolveTransportChatScript.mockResolvedValueOnce(null);
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId: "conv-no-scripts",
      title: "No scripts",
      subtitle: "",
      previewText: "No scripts",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [],
    };
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as import("vscode").ExtensionContext;

    await expect(
      restoreChatBundle(context, bundle, { report: () => {} })
    ).rejects.toThrow(/transport-chat scripts not found/);
  });

  it("runs disk verify after restore and throws on FAIL", async () => {
    mockRunDiskAndActivationVerify.mockResolvedValueOnce([
      { name: "global.composerHeaders", status: "FAIL", detail: "sidebar row missing" },
    ]);
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId: "conv-verify-fail",
      title: "Verify fail",
      subtitle: "",
      previewText: "Verify fail",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [],
    };
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as import("vscode").ExtensionContext;

    await expect(
      restoreChatBundle(context, bundle, { report: () => {} })
    ).rejects.toThrow(/Import verify failed/);
    expect(mockRunDiskAndActivationVerify).toHaveBeenCalled();
  });

  it("runs activation verify when postActivate without activate", async () => {
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId: "conv-post-activate",
      title: "Post activate",
      subtitle: "",
      previewText: "Post activate",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [],
    };
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
      extensionUri: { fsPath: path.join(tempHome, "extension") },
    } as import("vscode").ExtensionContext;

    await restoreChatBundle(context, bundle, { report: () => {} }, {
      postActivate: true,
      workspaceFolder: FIXTURE_REPO,
    });
    expect(mockRunDiskAndActivationVerify).toHaveBeenCalledWith(
      "conv-post-activate",
      expect.objectContaining({ chatsWorkspaceKey: expect.any(String) }),
      expect.objectContaining({ postActivate: false })
    );
    expect(mockVerifyActivationChecks).toHaveBeenCalledWith("conv-post-activate");
  });

  it("throws when no workspace folder is open", async () => {
    mockWorkspaceFolders.length = 0;
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId: "conv-no-ws",
      title: "No ws",
      subtitle: "",
      previewText: "No ws",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [],
    };

    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as import("vscode").ExtensionContext;

    await expect(
      restoreChatBundle(context, bundle, { report: () => {} })
    ).rejects.toThrow(/Open a workspace folder/);
  });
});

describe("restoreChatBundle import-v2 activation", () => {
  let tempHome: string;
  let savedHome: string | undefined;
  let runPostImportActivationSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-activate-"));
    savedHome = process.env.HOME;
    process.env.HOME = tempHome;
    mockHomedir.home = tempHome;
    mockRunDiskAndActivationVerify.mockReset();
    mockRunDiskAndActivationVerify.mockResolvedValue([
      { name: "store.db", status: "OK", detail: "mock ok" },
    ]);
    mockVerifyActivationChecks.mockReset();
    mockVerifyActivationChecks.mockResolvedValue([
      { name: "activation.status", status: "OK", detail: "completed" },
    ]);
    mockResolveTransportChatScript.mockReset();
    mockResolveTransportChatScript.mockResolvedValue("/fake/cursor_chat_io.py");
    mockRunPythonDiskImport.mockReset();
    mockRunPythonDiskImport.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "" });
    const activateMod = await import("../src/chat-import-activate.js");
    runPostImportActivationSpy = vi
      .spyOn(activateMod, "runPostImportActivation")
      .mockResolvedValue({
        ok: true,
        composerId: "conv-activate-ok",
        exitCode: 0,
        stagedOnly: false,
      });
    mockWorkspaceFolders.length = 0;
    mockWorkspaceFolders.push({
      uri: { fsPath: FIXTURE_REPO, scheme: "file" },
      name: "fixture",
      index: 0,
    });
  });

  afterEach(async () => {
    runPostImportActivationSpy.mockRestore();
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    mockHomedir.home = undefined;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  function minimalBundle(conversationId: string): ChatBundle {
    return {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId,
      title: "Activate test",
      subtitle: "",
      previewText: "Activate test",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [],
    };
  }

  it("runs post-import activation and activation verify when activate=true", async () => {
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const conversationId = "conv-activate-ok";
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
      extensionUri: { fsPath: path.join(tempHome, "extension") },
    } as import("vscode").ExtensionContext;

    await restoreChatBundle(context, minimalBundle(conversationId), { report: () => {} }, {
      activate: true,
      workspaceFolder: FIXTURE_REPO,
    });

    expect(runPostImportActivationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId }),
      conversationId,
      expect.objectContaining({ folderFsPath: path.resolve(FIXTURE_REPO) }),
      expect.objectContaining({ activateStrict: undefined })
    );
    expect(mockVerifyActivationChecks).toHaveBeenCalledWith(conversationId);
    expect(mockRunDiskAndActivationVerify).toHaveBeenCalledWith(
      conversationId,
      expect.any(Object),
      expect.objectContaining({ postActivate: false })
    );
  });

  it("throws when activateStrict and activation is staged-only", async () => {
    runPostImportActivationSpy.mockRejectedValueOnce(
      new Error(
        "Activation staged only (--activate-strict requires confirmed activation)"
      )
    );
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
      extensionUri: { fsPath: path.join(tempHome, "extension") },
    } as import("vscode").ExtensionContext;

    await expect(
      restoreChatBundle(
        context,
        minimalBundle("conv-activate-strict"),
        { report: () => {} },
        { activate: true, activateStrict: true, workspaceFolder: FIXTURE_REPO }
      )
    ).rejects.toThrow(/activate-strict/i);
  });

  it("throws when activation verify returns FAIL", async () => {
    mockVerifyActivationChecks.mockResolvedValueOnce([
      {
        name: "activation.result",
        status: "FAIL",
        detail: "missing result.json",
      },
    ]);
    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
      extensionUri: { fsPath: path.join(tempHome, "extension") },
    } as import("vscode").ExtensionContext;

    await expect(
      restoreChatBundle(
        context,
        minimalBundle("conv-activate-verify-fail"),
        { report: () => {} },
        { activate: true, workspaceFolder: FIXTURE_REPO }
      )
    ).rejects.toThrow(/Activation verify failed/);
  });
});

describe("restoreChatBundle in-process composer activation", () => {
  let tempHome: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-composer-cmd-"));
    savedHome = process.env.HOME;
    process.env.HOME = tempHome;
    mockHomedir.home = tempHome;
    mockRunDiskAndActivationVerify.mockReset();
    mockRunDiskAndActivationVerify.mockResolvedValue([
      { name: "store.db", status: "OK", detail: "mock ok" },
    ]);
    mockVerifyActivationChecks.mockReset();
    mockVerifyActivationChecks.mockResolvedValue([
      { name: "activation.status", status: "OK", detail: "completed" },
    ]);
    mockWorkspaceFolders.length = 0;
    mockWorkspaceFolders.push({
      uri: { fsPath: FIXTURE_REPO, scheme: "file" },
      name: "fixture",
      index: 0,
    });
    const vscodeMock = await import("./__mocks__/vscode.js");
    vscodeMock.__resetVscodeCommandsMock();
    vscodeMock.__setRegisteredCommands(["composer.createComposer"]);
    vscodeMock.__setExecuteCommandImpl(async (command: string) => {
      if (command === "composer.createComposer") {
        return "conv-inprocess";
      }
      return undefined;
    });
  });

  afterEach(async () => {
    const vscodeMock = await import("./__mocks__/vscode.js");
    vscodeMock.__resetVscodeCommandsMock();
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    mockHomedir.home = undefined;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("writes result.json when composer.createComposer is available", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.commands, "getCommands").mockResolvedValue([
      "composer.createComposer",
    ]);
    const {
      runComposerActivation,
      buildActivationManifest,
      normalizeActivationManifest,
      composerCommandAvailable,
    } = await import("../src/chat-import-activate.js");
    const { requireWorkspaceContext } = await import("../src/chat-workspace-context.js");
    expect(await composerCommandAvailable()).toBe(true);

    const conversationId = "conv-inprocess";
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-05-21T00:00:00.000Z",
      conversationId,
      title: "In-process",
      subtitle: "",
      previewText: "In-process",
      sidebarSnapshot: {
        conversationId,
        composerHeaders: {
          allComposers: [
            { composerId: conversationId, name: "In-process", createdAt: 1 },
          ],
        },
      },
      storeSnapshot: null,
      transcriptFiles: [],
    };
    const wsCtx = await requireWorkspaceContext({ workspaceFolder: FIXTURE_REPO });
    const raw = buildActivationManifest(bundle, conversationId, wsCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    (manifest.partialState as Record<string, unknown>).conversationMap = {
      "bubble-1": { type: 1 },
    };
    (manifest.partialState as Record<string, unknown>).fullConversationHeadersOnly = [
      { bubbleId: "bubble-1", type: 1 },
    ];

    const outcome = await runComposerActivation(manifest);
    expect(outcome.ok).toBe(true);

    const resultPath = path.join(
      tempHome,
      ".cursor",
      "import-activation",
      "result.json"
    );
    const resultRaw = await fs.readFile(resultPath, "utf-8");
    const result = JSON.parse(resultRaw) as { ok: boolean; composerId: string };
    expect(result.ok).toBe(true);
    expect(result.composerId).toBe(conversationId);
  });
});
