import {
  CHAT_BUNDLE_GIST_FILE_NAME,
  CHAT_BUNDLES_GIST_FILE_NAME,
  buildChatBundleFixture,
  clipboardWriteTextMock,
  createGistMock,
  gistConversationId,
  folderToProjectKey,
  flushMicrotasks,
  getGistMock,
  mockExportPicker,
  setupChatGistCase,
  setupExportConversation,
  showErrorMessageMock,
  showInformationMessageMock,
  showInputBoxMock,
  showQuickPickMock,
  showWarningMessageMock,
  teardownChatGistCase,
  transcriptFixture,
  type ChatGistExtensionContext,
} from "./chat-gist-export-import-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatBundle } from "../src/chat-persistence.js";

describe("chat gist export and import", () => {
  let tmpRoot: string;
  let mockWorkspaceFolder: string;
  let extensionContext: ChatGistExtensionContext;

  beforeEach(async () => {
    const env = await setupChatGistCase();
    tmpRoot = env.tmpRoot;
    mockWorkspaceFolder = env.mockWorkspaceFolder;
    extensionContext = env.extensionContext;
  });

  afterEach(async () => {
    await teardownChatGistCase(tmpRoot);
  });

  it("exports chat bundle to private gist with chat-bundle.json only", async () => {
    const workspaceKey = "chat-export-wk";
    const projectKey = "chat-export-project";
    const conversationId = gistConversationId(1);
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
    const conversationId = gistConversationId(2);
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
    const conversationId = gistConversationId(3);
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);

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
      showWarningMessageMock.mock.calls.some((c) =>
        String(c[0]).includes(`Chat "${conversationId}" loaded.`) &&
          String(c[0]).includes("Text-only Layer 4")
      )
    ).toBe(true);

    restoreSpy.mockRestore();
  });

  it("round-trips export gist bundle through import restore", async () => {
    const workspaceKey = "roundtrip-wk";
    const projectKey = "roundtrip-project";
    const conversationId1 = gistConversationId(4);
    const conversationId2 = gistConversationId(5);
    await setupExportConversation(tmpRoot, workspaceKey, conversationId1, {
      projectKey,
    });
    await setupExportConversation(tmpRoot, workspaceKey, conversationId2, {
      projectKey,
    });

    let exportedCollectionJson = "";
    mockExportPicker(workspaceKey, [conversationId1, conversationId2]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockImplementation(async (gistFiles: Record<string, { content: string }>) => {
      exportedCollectionJson = gistFiles[CHAT_BUNDLES_GIST_FILE_NAME].content;
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

    expect(exportedCollectionJson).not.toBe("");
    const exportedCollection = JSON.parse(exportedCollectionJson) as {
      type: string;
      bundles: ChatBundle[];
    };
    expect(exportedCollection.type).toBe("chat-bundles-collection");
    expect(exportedCollection.bundles).toHaveLength(2);

    const importTargetKey = folderToProjectKey(mockWorkspaceFolder);
    const importTargetDir = path.join(tmpRoot, ".cursor", "projects", importTargetKey);
    for (const conversationId of [conversationId1, conversationId2]) {
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
    }

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-roundtrip",
        html_url: "https://gist.github.com/example/gist-roundtrip",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLES_GIST_FILE_NAME]: { content: exportedCollectionJson },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValueOnce("https://gist.github.com/user/gist-roundtrip");
    showQuickPickMock.mockImplementation(
      async (
        items: Array<{ description?: string; activate?: boolean }>,
        options?: { canPickMany?: boolean }
      ) => {
        if (options?.canPickMany) {
          const pickedBundle = items.find((item) => item.description === conversationId1);
          return pickedBundle ? [pickedBundle] : [];
        }
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
      conversationId1,
      `${conversationId1}.jsonl`
    );
    expect(await fs.readFile(importedPath, "utf-8")).toBe(transcriptFixture);
    const notImportedPath = path.join(
      importTargetDir,
      "agent-transcripts",
      conversationId2,
      `${conversationId2}.jsonl`
    );
    await expect(fs.access(notImportedPath)).rejects.toThrow();
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
      'Gist chat import failed: Invalid chat export: expected type "chat-persistence" or "chat-bundles-collection", got "agent-transcripts".'
    );
    restoreSpy.mockRestore();
  });

  it("imports one chat from chat-bundles.json collection gist", async () => {
    const sourceProjectKey = "source-multi-project";
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const conv1 = gistConversationId(6);
    const conv2 = gistConversationId(7);
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);

    const collection = {
      schemaVersion: 1 as const,
      type: "chat-bundles-collection" as const,
      createdAt: "2026-05-20T12:00:00.000Z",
      sourceWorkspaceKey: "multi-wk",
      bundles: [
        buildChatBundleFixture({ conversationId: conv1, projectKey: sourceProjectKey }),
        buildChatBundleFixture({ conversationId: conv2, projectKey: sourceProjectKey }),
      ],
    };

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-multi-import",
        html_url: "https://gist.github.com/example/gist-multi-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLES_GIST_FILE_NAME]: {
            content: JSON.stringify(collection, null, 2),
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-multi-import");
    showQuickPickMock.mockImplementation(
      async (
        items: Array<{ description?: string; activate?: boolean; picked?: boolean }>,
        options?: { canPickMany?: boolean }
      ) => {
        if (options?.canPickMany) {
          return items.filter((item) =>
            item.description === conv1 || item.description === conv2
          );
        }
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) return activateItem;
        return items.find((item) => item.description === targetProjectKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const executeCommandMock = vi.mocked(
      (await import("vscode")).commands.executeCommand
    );

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).toHaveBeenCalledTimes(2);
    expect(restoreSpy.mock.calls.map((c) => c[1].conversationId).sort()).toEqual(
      [conv1, conv2].sort()
    );
    expect(executeCommandMock).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(showErrorMessageMock).not.toHaveBeenCalled();

    restoreSpy.mockRestore();
  });

  it("continues batch when second restore fails", async () => {
    const sourceProjectKey = "source-partial-project";
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const conv1 = gistConversationId(8);
    const conv2 = gistConversationId(9);
    const conv3 = gistConversationId(10);
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);

    const collection = {
      schemaVersion: 1 as const,
      type: "chat-bundles-collection" as const,
      createdAt: "2026-05-20T12:00:00.000Z",
      sourceWorkspaceKey: "partial-wk",
      bundles: [
        buildChatBundleFixture({ conversationId: conv1, projectKey: sourceProjectKey }),
        buildChatBundleFixture({ conversationId: conv2, projectKey: sourceProjectKey }),
        buildChatBundleFixture({ conversationId: conv3, projectKey: sourceProjectKey }),
      ],
    };

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-partial-import",
        html_url: "https://gist.github.com/example/gist-partial-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLES_GIST_FILE_NAME]: {
            content: JSON.stringify(collection, null, 2),
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-partial-import");
    showQuickPickMock.mockImplementation(
      async (
        items: Array<{ description?: string; activate?: boolean }>,
        options?: { canPickMany?: boolean }
      ) => {
        if (options?.canPickMany) {
          return items.filter((item) =>
            [conv1, conv2, conv3].includes(item.description ?? "")
          );
        }
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) return activateItem;
        return items.find((item) => item.description === targetProjectKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreChatBundle = chatMod.restoreChatBundle;
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");
    restoreSpy.mockImplementation(async (context, bundle, progress, options) => {
      if (bundle.conversationId === conv2) {
        throw new Error("restore failed");
      }
      return restoreChatBundle.call(chatMod, context, bundle, progress, options);
    });

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).toHaveBeenCalledTimes(3);
    expect(
      showWarningMessageMock.mock.calls.some((c) => /Imported 2\/3/i.test(String(c[0])))
    ).toBe(true);

    const conv1TranscriptPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      conv1,
      `${conv1}.jsonl`
    );
    expect(await fs.readFile(conv1TranscriptPath, "utf-8")).toBe(transcriptFixture);

    restoreSpy.mockRestore();
  });

  it("exports multiple chats to chat-bundles.json", async () => {
    const workspaceKey = "multi-export-wk";
    const id1 = gistConversationId(6);
    const id2 = gistConversationId(7);
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
