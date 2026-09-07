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

describe("chat-persistence bundle format", () => {
  it("produces a valid ChatBundle structure", () => {
    const transcriptContent = Buffer.from(
      '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n'
    );
    const encoded = encodeTranscriptArtifact(transcriptContent);
    const checksum = computeArtifactChecksum(transcriptContent);

    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: new Date().toISOString(),
      conversationId: "test-conv-001",
      title: "hello",
      subtitle: "1 file",
      previewText: "hello",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [
        {
          relativePath: "proj/agent-transcripts/test-conv-001/main.jsonl",
          content: encoded.content,
          encoding: encoded.encoding,
          checksum,
          sizeBytes: transcriptContent.length,
        },
      ],
    };

    expect(bundle.type).toBe("chat-persistence");
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.transcriptFiles).toHaveLength(1);
    expect(bundle.transcriptFiles[0]!.checksum).toBe(checksum);
  });

  it("round-trips transcript content through encode/decode", () => {
    const original = Buffer.from('{"role":"user","content":"test"}\n');
    const encoded = encodeTranscriptArtifact(original);
    const decoded = decodeTranscriptArtifact(encoded.content, encoded.encoding);

    expect(decoded.equals(original)).toBe(true);
  });

  it("round-trips store.db binary through base64", () => {
    // Simulate a small SQLite header
    const fakeSqliteHeader = Buffer.alloc(100);
    fakeSqliteHeader.write("SQLite format 3\0", 0, "ascii");
    crypto.randomFillSync(fakeSqliteHeader, 16);

    const encoded = encodeTranscriptArtifact(fakeSqliteHeader, true);
    expect(encoded.encoding).toBe("base64");

    const decoded = decodeTranscriptArtifact(encoded.content, encoded.encoding);
    expect(decoded.equals(fakeSqliteHeader)).toBe(true);

    const checksum = computeArtifactChecksum(fakeSqliteHeader);
    const verifyChecksum = computeArtifactChecksum(decoded);
    expect(verifyChecksum).toBe(checksum);
  });

  it("validates checksum integrity detection", () => {
    const content = Buffer.from("original content");
    const checksum = computeArtifactChecksum(content);

    const tampered = Buffer.from("tampered content");
    const tamperedChecksum = computeArtifactChecksum(tampered);

    expect(tamperedChecksum).not.toBe(checksum);
  });

  it("serializes and deserializes a full bundle via JSON", () => {
    const storeContent = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-04-03T00:00:00.000Z",
      conversationId: "conv-abc",
      title: "Test Chat",
      subtitle: "0 files",
      previewText: "Test Chat",
      sidebarSnapshot: {
        conversationId: "conv-abc",
        composerHeaders: { allComposers: [{ composerId: "conv-abc", name: "Test Chat" }] },
      },
      storeSnapshot: {
        content: storeContent.toString("base64"),
        encoding: "base64",
        checksum: computeArtifactChecksum(storeContent),
        sizeBytes: storeContent.length,
        sourceWorkspaceKey: "ws-123",
      },
      transcriptFiles: [],
    };

    const serialized = JSON.stringify(bundle);
    const deserialized = JSON.parse(serialized) as ChatBundle;

    expect(deserialized.type).toBe("chat-persistence");
    expect(deserialized.storeSnapshot?.checksum).toBe(bundle.storeSnapshot?.checksum);
    expect(deserialized.sidebarSnapshot?.conversationId).toBe("conv-abc");

    // Verify store round-trip
    const decodedStore = decodeTranscriptArtifact(
      deserialized.storeSnapshot!.content,
      deserialized.storeSnapshot!.encoding
    );
    expect(decodedStore.equals(storeContent)).toBe(true);
  });
});

describe("buildChatBundle scoped store lookup", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-scoped-store-"));
    mockHomedir.home = tempHome;
  });

  afterEach(async () => {
    mockHomedir.home = undefined;
    await fs.rm(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("buildChatBundle uses workspaceKey store only without fallback", async () => {
    const conversationId = "conv-scoped";
    const wkA = "wk-a";
    const wkB = "wk-b";
    await fs.mkdir(path.join(tempHome, ".cursor", "chats", wkA, conversationId), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempHome, ".cursor", "chats", wkB, conversationId), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tempHome, ".cursor", "chats", wkB, conversationId, "store.db"),
      "from-b"
    );
    const transcriptDir = path.join(
      tempHome,
      ".cursor",
      "projects",
      "proj-a",
      "agent-transcripts",
      conversationId
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDir, "main.jsonl"),
      '{"role":"user","content":"hello"}\n'
    );

    const { buildChatBundle } = await import("../src/chat-persistence.js");
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as import("vscode").ExtensionContext;
    const { bundle } = await buildChatBundle(context, conversationId, { report: () => {} }, {
      workspaceKey: wkA,
    });
    expect(bundle.storeSnapshot).toBeNull();
  });

  it("buildChatBundle includes subagent jsonl under subagents/", async () => {
    const conversationId = "conv-with-subagents";
    const projectKey = "proj-sub";
    const transcriptDir = path.join(
      tempHome,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      conversationId
    );
    const subagentDir = path.join(transcriptDir, "subagents");
    await fs.mkdir(subagentDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDir, `${conversationId}.jsonl`),
      '{"role":"user","content":"hello"}\n'
    );
    await fs.writeFile(
      path.join(subagentDir, "sub-111.jsonl"),
      '{"role":"assistant","content":"sub reply"}\n'
    );

    const { buildChatBundle } = await import("../src/chat-persistence.js");
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as import("vscode").ExtensionContext;
    const { bundle } = await buildChatBundle(context, conversationId, { report: () => {} });

    const rels = bundle.transcriptFiles.map((tf) => tf.relativePath).sort();
    expect(rels).toContain(
      `${projectKey}/agent-transcripts/${conversationId}/${conversationId}.jsonl`
    );
    expect(rels).toContain(
      `${projectKey}/agent-transcripts/${conversationId}/subagents/sub-111.jsonl`
    );
  });
});
