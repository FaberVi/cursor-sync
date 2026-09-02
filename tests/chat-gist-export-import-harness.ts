import { vi } from "vitest";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
} from "../src/transcript-bundle.js";
import type { ChatBundle } from "../src/chat-persistence.js";

export const CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json";
export const CHAT_BUNDLES_GIST_FILE_NAME = "chat-bundles.json";
export const CURSOR_CHAT_GIST_FILE_NAME = "cursor-chat.json";

const gistMocks = vi.hoisted(() => ({
  createGistMock: vi.fn(),
  getGistMock: vi.fn(),
  requireTokenMock: vi.fn(),
  getTokenMock: vi.fn(),
  withRetryMock: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  appendLineMock: vi.fn(),
  showInformationMessageMock: vi.fn(),
  showWarningMessageMock: vi.fn(),
  showErrorMessageMock: vi.fn(),
  showInputBoxMock: vi.fn(),
  showQuickPickMock: vi.fn(),
  clipboardWriteTextMock: vi.fn(),
  requireChatEncryptionPasswordMock: vi.fn(),
  encryptChatGistPayloadMock: vi.fn(),
  decryptChatGistPayloadMock: vi.fn(),
  isEncryptedChatGistPayloadMock: vi.fn(),
  mockRunDiskAndActivationVerify: vi.fn(async () => [
    { name: "store.db", status: "OK" as const, detail: "mock ok" },
  ]),
}));

export const createGistMock = gistMocks.createGistMock;
export const getGistMock = gistMocks.getGistMock;
export const requireTokenMock = gistMocks.requireTokenMock;
export const getTokenMock = gistMocks.getTokenMock;
export const withRetryMock = gistMocks.withRetryMock;
export const appendLineMock = gistMocks.appendLineMock;
export const showInformationMessageMock = gistMocks.showInformationMessageMock;
export const showWarningMessageMock = gistMocks.showWarningMessageMock;
export const showErrorMessageMock = gistMocks.showErrorMessageMock;
export const showInputBoxMock = gistMocks.showInputBoxMock;
export const showQuickPickMock = gistMocks.showQuickPickMock;
export const clipboardWriteTextMock = gistMocks.clipboardWriteTextMock;
export const requireChatEncryptionPasswordMock = gistMocks.requireChatEncryptionPasswordMock;
export const encryptChatGistPayloadMock = gistMocks.encryptChatGistPayloadMock;
export const decryptChatGistPayloadMock = gistMocks.decryptChatGistPayloadMock;
export const isEncryptedChatGistPayloadMock = gistMocks.isEncryptedChatGistPayloadMock;
export const mockRunDiskAndActivationVerify = gistMocks.mockRunDiskAndActivationVerify;

export const mockedHomeDir = { current: "" };
export const mockWorkspaceFolder = { current: "" };

export const configurationValues: Record<string, unknown> = {
  "transcripts.autoReloadAfterImport": false,
  "chatImport.activateDefault": false,
  "chatImport.activateStrict": false,
  "chatImport.bridgeWaitResultSeconds": 0,
  "chatImport.pingServer": false,
  "chatGist.encrypt": false,
};

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockedHomeDir.current,
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
  EventEmitter: class<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: T): void {
      for (const l of this.listeners) l(data);
    }
    dispose(): void {}
  },
  workspace: {
    get workspaceFolders() {
      return [
        {
          uri: { fsPath: mockWorkspaceFolder.current, scheme: "file" },
          name: "workspace",
          index: 0,
        },
      ];
    },
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
      update: vi.fn(),
      inspect: () => undefined,
      has: () => true,
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: appendLineMock,
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: showInformationMessageMock,
    showWarningMessage: showWarningMessageMock,
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

vi.mock("../src/gist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gist.js")>();
  return {
    ...actual,
    GistClient: class {
      createGist = createGistMock;
      getGist = getGistMock;
    },
  };
});

vi.mock("../src/auth.js", () => ({
  requireToken: requireTokenMock,
  getToken: getTokenMock,
}));

vi.mock("../src/retry.js", () => ({
  withRetry: withRetryMock,
}));

vi.mock("../src/chat-encryption-auth.js", () => ({
  requireChatEncryptionPassword: requireChatEncryptionPasswordMock,
  isChatGistEncryptionEnabled: vi.fn(() => configurationValues["chatGist.encrypt"] !== false),
  setChatEncryptionPassword: vi.fn(async () => {}),
  clearChatEncryptionPassword: vi.fn(async () => {}),
}));

vi.mock("../src/chat-gist-crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-gist-crypto.js")>();
  return {
    encryptChatGistPayload: encryptChatGistPayloadMock,
    decryptChatGistPayload: decryptChatGistPayloadMock,
    isEncryptedChatGistPayload: isEncryptedChatGistPayloadMock,
    ChatGistCryptoError: actual.ChatGistCryptoError,
  };
});

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../src/rollback.js", () => ({
  createBackup: vi.fn(async () => ({ backupDir: "", entries: [] })),
  rollbackFromBackup: vi.fn(async () => {}),
  pruneOldBackups: vi.fn(async () => {}),
}));

vi.mock("../src/chat-transport-scripts.js", () => ({
  resolveTransportChatScript: vi.fn(async () => "/fake/cursor_chat_io.py"),
  runPythonExportDiskKvSnapshot: vi.fn(async () => null),
  runPythonBundleInspect: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: "{}", stderr: "" })),
  runPythonDiskImport: vi.fn(async (opts: {
    bundlePath: string;
    workspaceFolder: string;
    targetProject?: string;
    stateDbPath?: string;
    dryRun?: boolean;
    syncGlobal?: boolean;
    pinRecent?: boolean;
  }) => {
    const fsMod = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const osMod = await import("node:os");
    const { decodeTranscriptArtifact } = await import("../src/transcript-bundle.js");
    const { md5FolderKey, requireWorkspaceContext } = await import("../src/chat-workspace-context.js");
    const { mergeSidebarIntoStateDb, mergeTargetsForImport } = await import("../src/chat-import-merge.js");

    const home = osMod.homedir();
    const bundleRaw = await fsMod.readFile(opts.bundlePath, "utf8");
    const bundle = JSON.parse(bundleRaw) as import("../src/chat-persistence.js").ChatBundle;

    if (!opts.dryRun) {
      if (bundle.storeSnapshot) {
        const chatsKey = md5FolderKey(pathMod.resolve(opts.workspaceFolder));
        const storeDir = pathMod.join(
          home,
          ".cursor",
          "chats",
          chatsKey,
          bundle.conversationId
        );
        await fsMod.mkdir(storeDir, { recursive: true });
        const decoded = decodeTranscriptArtifact(
          bundle.storeSnapshot.content,
          bundle.storeSnapshot.encoding
        );
        await fsMod.writeFile(pathMod.join(storeDir, "store.db"), decoded);
      }

      const projectsRoot = pathMod.join(home, ".cursor", "projects");
      for (const tf of bundle.transcriptFiles) {
        const decoded = decodeTranscriptArtifact(tf.content, tf.encoding);
        const targetPath = pathMod.join(projectsRoot, tf.relativePath);
        await fsMod.mkdir(pathMod.dirname(targetPath), { recursive: true });
        await fsMod.writeFile(targetPath, decoded);
      }

      if (bundle.sidebarSnapshot && opts.stateDbPath) {
        const wsCtx = await requireWorkspaceContext({ workspaceFolder: opts.workspaceFolder });
        const targets = await mergeTargetsForImport(opts.stateDbPath, opts.syncGlobal ?? true);
        for (const dbPath of targets) {
          await mergeSidebarIntoStateDb(
            dbPath,
            bundle,
            wsCtx.workspaceIdentifier as import("../src/chat-import-merge.js").WorkspaceIdentifier,
            { pinRecent: opts.pinRecent ?? true }
          );
        }
      }
    }

    return { ok: true, exitCode: 0, stdout: "", stderr: "" };
  }),
}));

export function gistConversationId(n: number): string {
  return `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function folderToProjectKey(folderFsPath: string): string {
  const resolved = path.resolve(folderFsPath);
  return resolved
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):(?:\/|$)/, (_, letter: string) => `${letter.toLowerCase()}/`)
    .replace(/:/g, "")
    .replace(/^\/+/, "")
    .replace(/\//g, "-");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const transcriptFixture = readFileSync(
  path.join(testsDir, "fixtures", "transcripts-bundle-v2", "conversation.jsonl"),
  "utf-8"
);

export function buildChatBundleFixture(options: {
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

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function mockExportPicker(workspaceKey: string, conversationIds: string[]) {
  showQuickPickMock.mockResolvedValueOnce(
    conversationIds.map((id) => ({ description: id, label: id }))
  );
}

export async function setupExportConversation(
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

export type ChatGistExtensionContext = {
  globalStorageUri: { fsPath: string };
  extensionUri: { fsPath: string };
  globalState: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};

const savedEnv: { USERPROFILE?: string; HOME?: string; APPDATA?: string } = {};

function isolateHomeEnv(tmpRoot: string): void {
  savedEnv.USERPROFILE = process.env.USERPROFILE;
  savedEnv.HOME = process.env.HOME;
  savedEnv.APPDATA = process.env.APPDATA;
  process.env.USERPROFILE = tmpRoot;
  process.env.HOME = tmpRoot;
  process.env.APPDATA = path.join(tmpRoot, "AppData", "Roaming");
}

function restoreHomeEnv(): void {
  if (savedEnv.USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = savedEnv.USERPROFILE;
  }
  if (savedEnv.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedEnv.HOME;
  }
  if (savedEnv.APPDATA === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = savedEnv.APPDATA;
  }
}

export async function setupChatGistCase(): Promise<{
  tmpRoot: string;
  mockWorkspaceFolder: string;
  extensionContext: ChatGistExtensionContext;
}> {
  const tmpRoot = await fs.mkdtemp(
    path.join(process.env.TEMP || process.env.TMP || "/tmp", "cursor-sync-chat-gist-")
  );
  mockedHomeDir.current = tmpRoot;
  isolateHomeEnv(tmpRoot);
  mockWorkspaceFolder.current = path.join(tmpRoot, "workspace-repo");
  await fs.mkdir(mockWorkspaceFolder.current, { recursive: true });
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
  showWarningMessageMock.mockReset();
  showErrorMessageMock.mockReset();
  showInputBoxMock.mockReset();
  showQuickPickMock.mockReset();
  clipboardWriteTextMock.mockReset();
  requireChatEncryptionPasswordMock.mockReset();
  encryptChatGistPayloadMock.mockReset();
  decryptChatGistPayloadMock.mockReset();
  isEncryptedChatGistPayloadMock.mockReset();
  requireChatEncryptionPasswordMock.mockResolvedValue(undefined);
  encryptChatGistPayloadMock.mockImplementation(async (plain: string) => `{"cursorSyncEncrypted":{}}${plain}`);
  isEncryptedChatGistPayloadMock.mockReturnValue(false);
  decryptChatGistPayloadMock.mockImplementation(async (_env: string, _pw: string) => "");
  configurationValues["chatGist.encrypt"] = false;
  configurationValues["transcripts.autoReloadAfterImport"] = false;
  requireTokenMock.mockResolvedValue("ghp_chat_export_token");
  getTokenMock.mockResolvedValue("ghp_chat_import_token");
  const extensionContext = {
    globalStorageUri: {
      fsPath: path.join(tmpRoot, ".cursor-sync-global-storage"),
    },
    extensionUri: {
      fsPath: path.resolve(testsDir, ".."),
    },
    globalState: {
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
  await fs.mkdir(extensionContext.globalStorageUri.fsPath, { recursive: true });
  return { tmpRoot, mockWorkspaceFolder: mockWorkspaceFolder.current, extensionContext };
}

export async function teardownChatGistCase(tmpRoot: string): Promise<void> {
  restoreHomeEnv();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
}
