import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const transcriptFixture = readFileSync(
  path.join(testsDir, "fixtures", "transcripts-bundle-v2", "conversation.jsonl"),
  "utf-8"
);

const getGistMock = vi.fn();
const getTokenMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInputBoxMock = vi.fn();
const showQuickPickMock = vi.fn();
const executeCommandMock = vi.fn();
const appendLineMock = vi.fn();

let mockedHomeDir = "";
let mockWorkspaceFolder = "";

const configurationValues: Record<string, unknown> = {
  "transcripts.autoReloadAfterImport": false,
};

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockedHomeDir,
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
    showWarningMessage: vi.fn(),
    showErrorMessage: showErrorMessageMock,
    showInputBox: showInputBoxMock,
    showQuickPick: showQuickPickMock,
    withProgress: async (
      _options: unknown,
      task: (progress: { report: (value: { message?: string; increment?: number }) => void }) => Promise<unknown>
    ) => task({ report: vi.fn() }),
  },
  commands: {
    executeCommand: executeCommandMock,
  },
  ProgressLocation: {
    Notification: 15,
  },
}));

vi.mock("../src/gist.js", () => ({
  GistClient: class {
    getGist = getGistMock;
  },
}));

vi.mock("../src/auth.js", () => ({
  getToken: getTokenMock,
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../src/rollback.js", () => ({
  createBackup: vi.fn(async () => ({ entries: [] })),
  rollbackFromBackup: vi.fn(),
  pruneOldBackups: vi.fn(),
}));

vi.mock("../src/transcripts.js", () => ({
  __chatPersistenceInternals: {
    runSqliteScript: vi.fn(async () => undefined),
    resolveStateDbCandidates: vi.fn(async () => ["/fake/state.vscdb"]),
    resolveChatsRoot: vi.fn(() => path.join(mockedHomeDir, ".cursor", "chats")),
    escapeSqlLiteral: vi.fn((s: string) => s.replace(/'/g, "''")),
    mergeComposerHeadersChain: vi.fn((_existing: string | undefined, payloads: unknown[]) => ({
      allComposers: payloads,
    })),
    mergeComposerDataAdditive: vi.fn(),
    deriveComposerHeadersPayloadFromSidebarSnapshot: vi.fn(() => ({
      composerId: "conv-reload-123",
      name: "Reload test",
    })),
    stampWorkspaceIdentifierOnPayload: vi.fn((p: Record<string, unknown>) => p),
    isExecFileTimeoutError: vi.fn(() => false),
    querySqliteRows: vi.fn(async () => []),
  },
}));

function buildV1Manifest(projectKey: string, relativePath: string, content: string) {
  const syncKey = `transcripts/${projectKey}/${relativePath}`;
  const checksum = crypto.createHash("sha256").update(content).digest("hex");
  return {
    schemaVersion: 1 as const,
    type: "agent-transcripts" as const,
    createdAt: "2026-03-30T12:00:00.000Z",
    sourceMachineId: "source-machine",
    sourceOS: "linux",
    sourceProjects: {
      [projectKey]: { folderName: projectKey, fileCount: 1 },
    },
    files: {
      [syncKey]: {
        projectKey,
        checksum,
        sizeBytes: Buffer.byteLength(content, "utf-8"),
      },
    },
  };
}

describe("import gist transcripts reload prompt", () => {
  let tmpRoot: string;
  let extensionContext: { globalStorageUri: { fsPath: string } };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-gist-transcript-reload-"));
    mockedHomeDir = tmpRoot;
    mockWorkspaceFolder = path.join(tmpRoot, "workspace-repo");
    await fs.mkdir(mockWorkspaceFolder, { recursive: true });
    await fs.mkdir(path.join(tmpRoot, ".cursor", "chats", "ws-reload"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", "local-project"), {
      recursive: true,
    });

    getGistMock.mockReset();
    getTokenMock.mockReset();
    showInputBoxMock.mockReset();
    showQuickPickMock.mockReset();
    showInformationMessageMock.mockReset();
    showErrorMessageMock.mockReset();
    executeCommandMock.mockReset();

    configurationValues["transcripts.autoReloadAfterImport"] = false;
    getTokenMock.mockResolvedValue("ghp_gist_transcript_token");

    extensionContext = {
      globalStorageUri: {
        fsPath: path.join(tmpRoot, ".cursor-sync-global-storage"),
      },
    };
    await fs.mkdir(extensionContext.globalStorageUri.fsPath, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("offers Reload Window when autoReloadAfterImport is false and sidebar merged", async () => {
    const sourceProjectKey = "source-project";
    const relativePath = "conv-reload-123/conv-reload-123.jsonl";
    const syncKey = `transcripts/${sourceProjectKey}/${relativePath}`;
    const manifest = buildV1Manifest(sourceProjectKey, relativePath, transcriptFixture);

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-transcript-reload",
        html_url: "https://gist.github.com/example/gist-transcript-reload",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [syncKey]: { content: transcriptFixture },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-transcript-reload");
    showQuickPickMock.mockImplementationOnce(async (items: Array<{ label?: string; description?: string }>) => {
      const keep = items.find((item) => item.label === "(Keep original)");
      if (keep) return keep;
      return items.find((item) => item.description === "local-project") ?? items[0];
    });
    showInformationMessageMock.mockResolvedValue(undefined);

    const { executeImportTranscriptsFromGist } = await import("../src/import-gist-transcripts.js");
    await executeImportTranscriptsFromGist(extensionContext as never);

    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect(
      showInformationMessageMock.mock.calls.some(
        (c) =>
          String(c[0]).includes("Reload to see them") && c.includes("Reload Window")
      )
    ).toBe(true);
    expect(executeCommandMock).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
  });
});
